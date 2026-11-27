import { resolve } from 'node:path';
import { SQLiteStore } from '@primusscope/storage';
import { neonClient, PostgresPublicationStore, type PublishedState } from '@primusscope/storage/postgres';
import{BlobPublicationStore}from'@primusscope/storage/blob';
import{readCollectorFailure,type CollectorFailure}from'@primusscope/storage/collector-status';
import {MAX_BLOB_PUBLICATION_BYTES,type HostedPublication} from '@primusscope/storage/publication';
import { z } from 'zod';
import {
  DecimalStringSchema, IsoTimestampSchema, ObservationSetSchema, Sha256Schema,
  type ObservationSet,
} from '@primusscope/api-schema';
import recordedObservations from '../../../data/observations/current.json';

export class DataAccessError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'DataAccessError';
  }
}

export const ServingModeSchema = z.enum(['recorded_observations', 'indexed_observations']);
export type ServingMode = z.infer<typeof ServingModeSchema>;
const nullableTime = IsoTimestampSchema.nullable();
export const PublicIndexerDomainStatusSchema = z.object({
  domain: z.enum(['finance', 'network']), chainId: z.union([z.literal(56), z.literal(8453)]),
  fromBlock: DecimalStringSchema, toBlock: DecimalStringSchema, nextBlock: DecimalStringSchema,
  toTime: IsoTimestampSchema, observedAt: IsoTimestampSchema, quarantined: z.boolean(),
  lastAttemptAt: nullableTime, lastSuccessAt: nullableTime,
  lastOutcome: z.enum(['idle', 'advanced', 'failed']).nullable(),
  lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  targetFinalizedBlock: DecimalStringSchema.nullable(), sourceAsOf: nullableTime,
  lagBlocks: DecimalStringSchema.nullable(), asObservedAt: nullableTime,
  retryAfterSeconds: z.number().int().min(0).max(86400).nullable(), nextRetryAt: nullableTime,
  stale: z.boolean(),
}).strict();
const CollectorFailurePublicSchema=z.object({failedAt:IsoTimestampSchema,code:z.enum(['CAPACITY_EXCEEDED','DATABASE_UNAVAILABLE','SOURCE_UNAVAILABLE','PUBLICATION_CONFLICT','LEASE_BUSY','LEASE_LOST','NOT_INITIALIZED','INVALID_PUBLICATION','COLLECTION_FAILED'])}).strict();
export const PublicIndexerStatusSchema = z.object({
  mode: ServingModeSchema, storage: z.enum(['bundled_snapshot', 'local_sqlite', 'hosted_postgres','hosted_blob']),
  publication: z.enum(['available', 'quarantined', 'empty']), snapshotId: Sha256Schema.nullable(),
  continuousWorker: z.literal(false), domains: z.array(PublicIndexerDomainStatusSchema).max(2),
  collectionMode: z.enum(['manual', 'scheduled']).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  lastRunUrl: z.string().regex(/^https:\/\/github\.com\/mssystem1\/PrimusScope\/actions\/runs\/[0-9]+$/).nullable().optional(),
  recovery: z.object({source:z.enum(['process_cache','bundled_snapshot']),issue:z.literal('PRIMARY_STORE_UNAVAILABLE')}).strict().optional(),
  historical:z.boolean().optional(),
  collectorFailure:CollectorFailurePublicSchema.nullable().optional(),
  capacity:z.object({publicationBytes:z.number().int().nonnegative(),publicationLimitBytes:z.literal(MAX_BLOB_PUBLICATION_BYTES),networkEvents:z.number().int().nonnegative(),networkEventLimit:z.literal(100_000)}).strict().optional(),
}).strict();
export type PublicIndexerStatus = z.infer<typeof PublicIndexerStatusSchema>;
export type ServingContext = { mode: ServingMode; indexerStatus: PublicIndexerStatus | null };
export type ServingState = ServingContext & { snapshot: ObservationSet };

const safeIssueCodes = new Set([
  'RPC_TIMEOUT', 'RPC_HTTP_ERROR', 'RPC_RATE_LIMITED', 'RPC_INVALID_RESPONSE', 'RPC_RESPONSE_TOO_LARGE',
  'RPC_BUDGET_EXHAUSTED', 'RPC_ERROR', 'CHAIN_MISMATCH', 'IMPLEMENTATION_MISMATCH', 'UNKNOWN_EVENT',
  'UNKNOWN_IMPLEMENTATION', 'ABI_MISMATCH', 'ABI_DECODE_FAILED', 'DECODE_FAILED', 'CHECKPOINT_REORG',
  'REORG_DETECTED', 'DEEP_REORG', 'BUDGET_EXHAUSTED', 'REQUEST_BUDGET_EXHAUSTED', 'STORE_UNAVAILABLE',
  'SOURCE_UNAVAILABLE', 'WORKER_FAILED', 'LEASE_LOST', 'LEASE_BUSY', 'EVENT_LIMIT_EXCEEDED',
  'FINALIZED_BEHIND_CHECKPOINT', 'NON_CONTIGUOUS_RANGE', 'CHECKPOINT_MISMATCH', 'NO_FINALIZED_HEAD',
  'REQUEST_BUDGET_EXCEEDED', 'REORG_BELOW_CHECKPOINT', 'DECODE_ERROR', 'INCONSISTENT_RESPONSE',
  'INDEXING_FAILED', 'CAPACITY_EXCEEDED', 'REQUEST_LIMIT', 'PROVIDER_ERROR', 'RANGE_INCOMPLETE',
  'REQUEST_TIMEOUT', 'RATE_LIMITED', 'RPC_ARCHIVE_UNAVAILABLE', 'RPC_RANGE_LIMIT', 'RPC_TRANSPORT_ERROR',
  'HTTP_FORBIDDEN', 'HTTP_SERVER_ERROR', 'INVALID_RPC_RESPONSE', 'RESPONSE_TOO_LARGE',
  'RUN_DEADLINE_EXHAUSTED', 'TLS_VERIFICATION_FAILED', 'COOLDOWN_ACTIVE',
  'CHECKPOINT_HASH_CHANGED', 'CHECKPOINT_TIME_CHANGED', 'IMPLEMENTATION_CHANGED',
  'RUNTIME_CODE_CHANGED', 'IMPLEMENTATION_CODE_CHANGED', 'IMPLEMENTATION_UPGRADE_IN_RANGE',
  'RECEIPT_MISMATCH', 'BLOCK_HASH_MISMATCH', 'APPEND_PARENT_MISMATCH', 'WRONG_CHAIN',
  'FINALIZED_HEAD_BEHIND_CHECKPOINT', 'SINGLE_BLOCK_EVENT_LIMIT', 'EVENT_DECODE_FAILED',
]);

/** Configuration-only: no filesystem creation, SQLite open or provider access. */
export function getServingMode(): ServingMode {
  const value = process.env.PRIMUSSCOPE_DATA_MODE ?? 'recorded';
  if (value === 'recorded') return 'recorded_observations';
  if (value === 'indexed' || value === 'hosted'||value==='blob') return 'indexed_observations';
  throw new DataAccessError('UNSUPPORTED_CONFIGURATION', 'The configured observation serving mode is unsupported.', 503);
}

export function getServingContext(): ServingContext {
  return { mode: getServingMode(), indexerStatus: null };
}

function bundledSnapshot(): ObservationSet {
  try { return ObservationSetSchema.parse(recordedObservations); }
  catch { throw new DataAccessError('SOURCE_UNAVAILABLE', 'The recorded observation store could not be validated.', 503); }
}

function openReadOnlyStore(): SQLiteStore {
  if (process.env.VERCEL) {
    throw new DataAccessError('UNSUPPORTED_CONFIGURATION',
      'Local SQLite indexing is not configured for this deployment. A durable serving database is required.', 503);
  }
  const path = process.env.PRIMUSSCOPE_DB_PATH;
  // Launchers set an absolute path. The bounded default also supports running
  // directly from apps/web without traversing arbitrary parent directories.
  const defaultPath = process.cwd().endsWith('/apps/web')
    ? resolve(process.cwd(), '../../.local/indexer.sqlite')
    : resolve(process.cwd(), '.local/indexer.sqlite');
  try { return new SQLiteStore(path ? resolve(path) : defaultPath, { readOnly: true }); }
  catch { throw new DataAccessError('SOURCE_UNAVAILABLE', 'The indexed observation store is unavailable.', 503); }
}

function publicStatus(raw: ReturnType<SQLiteStore['getStatus']>): PublicIndexerStatus {
  return PublicIndexerStatusSchema.parse({
    mode: 'indexed_observations', storage: 'local_sqlite', publication: raw.publication,
    snapshotId: raw.snapshotId, continuousWorker: false,
    domains: raw.domains.map(domain => ({
      domain: domain.domain, chainId: domain.chainId, fromBlock: domain.fromBlock,
      toBlock: domain.toBlock, nextBlock: domain.nextBlock, toTime: domain.toTime,
      observedAt: domain.observedAt, quarantined: domain.quarantined,
      lastAttemptAt: domain.lastAttemptAt, lastSuccessAt: domain.lastSuccessAt,
      lastOutcome: domain.lastOutcome,
      lastErrorCode: domain.lastErrorCode === null ? null
        : safeIssueCodes.has(domain.lastErrorCode) ? domain.lastErrorCode : 'WORKER_FAILED',
      targetFinalizedBlock: domain.targetFinalizedBlock, sourceAsOf: domain.sourceAsOf,
      lagBlocks: domain.lagBlocks, asObservedAt: domain.asObservedAt,
      retryAfterSeconds: domain.retryAfterSeconds, nextRetryAt: domain.nextRetryAt,
      stale:false,
    })),
  });
}

/** Status remains readable when publication is quarantined. */
export async function getIndexerStatus(): Promise<PublicIndexerStatus> {
  if (['hosted','blob'].includes(process.env.PRIMUSSCOPE_DATA_MODE??'')) {
    const state=await recoverableHostedState(true);return state.indexerStatus!;
  }
  if (getServingMode() === 'recorded_observations') {
    return { mode: 'recorded_observations', storage: 'bundled_snapshot', publication: 'available',
      snapshotId: bundledSnapshot().snapshotId, continuousWorker: false, domains: [] };
  }
  const store = openReadOnlyStore();
  try { return publicStatus(store.getStatus()); }
  catch { throw new DataAccessError('SOURCE_UNAVAILABLE', 'The indexer status could not be validated.', 503); }
  finally { store.close(); }
}

export async function getServingState(): Promise<ServingState> {
  const mode = getServingMode();
  if (mode === 'recorded_observations') return { snapshot: bundledSnapshot(), mode, indexerStatus: null };
  if (['hosted','blob'].includes(process.env.PRIMUSSCOPE_DATA_MODE??'')) {
    return recoverableHostedState();
  }
  const store = openReadOnlyStore();
  try {
    const { snapshot, status } = store.readServingState();
    const indexerStatus = publicStatus(status);
    if (indexerStatus.publication !== 'available') {
      throw new DataAccessError('PUBLICATION_QUARANTINED', 'Indexed observations are awaiting source reconciliation. Inspect indexer status.', 503);
    }
    const validated = ObservationSetSchema.parse(snapshot);
    if (indexerStatus.snapshotId !== validated.snapshotId) throw new Error('Snapshot publication mismatch');
    return { snapshot: validated, mode, indexerStatus };
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    // A quarantined store can reject readServingState before returning a
    // snapshot. Its independent public status is still useful and safe.
    try {
      if (store.getStatus().publication === 'quarantined') {
        throw new DataAccessError('PUBLICATION_QUARANTINED', 'Indexed observations are awaiting source reconciliation. Inspect indexer status.', 503);
      }
    } catch (statusError) { if (statusError instanceof DataAccessError) throw statusError; }
    throw new DataAccessError('SOURCE_UNAVAILABLE', 'The indexed observation store could not be validated.', 503);
  } finally { store.close(); }
}

let hostedCache: { connection: string; state: PublishedState } | undefined;
let hostedFailure: {connection:string;retryAt:number}|undefined;
let blobCheckedAt=0;
let blobInFlight:{key:string;promise:Promise<PublishedState>}|undefined;
let collectorFailureCache:{key:string;checkedAt:number;value:CollectorFailure|null;unavailable:boolean}|undefined;
let collectorFailureInFlight:{key:string;promise:Promise<CollectorFailure|null>}|undefined;
const capacityCache=new WeakMap<HostedPublication,{publicationBytes:number;publicationLimitBytes:64_000_000;networkEvents:number;networkEventLimit:100_000}>();
function usesBlob(){return process.env.PRIMUSSCOPE_DATA_MODE==='blob'||process.env.PRIMUSSCOPE_PUBLICATION_STORE==='blob';}
function primaryKey(){return usesBlob()?'blob:'+(process.env.BLOB_STORE_ID??process.env.BLOB_READ_WRITE_TOKEN??'runtime'):process.env.WEB_DATABASE_URL;}
async function recoverableHostedState(statusOnly=false):Promise<ServingState>{
  try{
    const {publication}=await hostedPublication(),indexerStatus=usesBlob()?await hostedBlobStatus(publication):hostedStatus(publication);
    if(!statusOnly&&indexerStatus.publication!=='available')throw new DataAccessError('PUBLICATION_QUARANTINED','Indexed observations are awaiting source reconciliation. Inspect indexer status.',503);
    return{snapshot:ObservationSetSchema.parse(publication.snapshot),mode:'indexed_observations',indexerStatus};
  }catch(error){
    if(error instanceof DataAccessError&&error.code==='PUBLICATION_QUARANTINED')throw error;
    const cached=hostedCache&&hostedCache.connection===primaryKey()?hostedCache.state:null;
    if(!statusOnly&&cached?.publication.checkpoints.some(c=>c.quarantined))throw new DataAccessError('PUBLICATION_QUARANTINED','Indexed observations are awaiting source reconciliation. Inspect indexer status.',503);
    if(cached){const status=usesBlob()?await hostedBlobStatus(cached.publication):hostedStatus(cached.publication);return{snapshot:ObservationSetSchema.parse(cached.publication.snapshot),mode:'indexed_observations',indexerStatus:{...status,recovery:{source:'process_cache',issue:'PRIMARY_STORE_UNAVAILABLE'}}};}
    const snapshot=bundledSnapshot();return{snapshot,mode:'recorded_observations',indexerStatus:{mode:'recorded_observations',storage:'bundled_snapshot',publication:'available',snapshotId:snapshot.snapshotId,continuousWorker:false,domains:[],recovery:{source:'bundled_snapshot',issue:'PRIMARY_STORE_UNAVAILABLE'}}};
  }
}
async function hostedPublication() {
  const connection = primaryKey(),blob=usesBlob();
  if (!connection) throw new DataAccessError('SOURCE_UNAVAILABLE', 'The hosted observation store is not configured.', 503);
  if(hostedFailure?.connection===connection&&hostedFailure.retryAt>Date.now())throw new DataAccessError('SOURCE_UNAVAILABLE','The hosted observation store is unavailable.',503);
  try {
    if(blob){
      if(hostedCache?.connection===connection&&Date.now()-blobCheckedAt<300000)return hostedCache.state;
      if(blobInFlight?.key===connection)return blobInFlight.promise;
      const promise=(async()=>{const store=new BlobPublicationStore({token:process.env.BLOB_READ_WRITE_TOKEN,readOnly:true,useCache:true});const state=await readDeadline(store.read(),6000);if(!state)throw new Error('EMPTY_BLOB');hostedCache={connection,state};blobCheckedAt=Date.now();hostedFailure=undefined;return state;})();
      blobInFlight={key:connection,promise};try{return await promise;}finally{if(blobInFlight?.promise===promise)blobInFlight=undefined;}
    }
    const client=neonClient(connection);
    const store = new PostgresPublicationStore({async query(text,values){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([client.query(text,values),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('READ_TIMEOUT')),3000);})]);}finally{clearTimeout(timer);}}}, true);
    const cached = hostedCache?.connection === connection ? hostedCache.state : null;
    if (cached && await store.revision() === cached.revision) return cached;
    const state = await store.read();
    if (!state) throw new Error();
    hostedCache = { connection, state };
    hostedFailure=undefined;
    return state;
  } catch { hostedFailure={connection,retryAt:Date.now()+60000};throw new DataAccessError('SOURCE_UNAVAILABLE', 'The hosted observation store is unavailable.', 503); }
}

function hostedStatus(publication: HostedPublication, blobMode=usesBlob()): PublicIndexerStatus {
  const status = publicStatus({ storage: 'sqlite',
    publication: publication.checkpoints.some(c => c.quarantined) ? 'quarantined' : 'available',
    snapshotId: publication.snapshot.snapshotId, domains: publication.checkpoints });
  const interval=publication.collector.intervalMinutes;
  const staleAfter=interval===null?Infinity:(interval+30)*60_000,now=Date.now();
  const domains=status.domains.map(domain=>{
    const times=[domain.lastAttemptAt,domain.asObservedAt,domain.observedAt].filter((value):value is string=>value!==null).map(Date.parse);
    const lastStatusTime=times.length?Math.max(...times):NaN;
    return{...domain,stale:publication.collector.mode==='scheduled'&&Number.isFinite(lastStatusTime)&&now-lastStatusTime>staleAfter};
  });
  const result:PublicIndexerStatus={ ...status,domains, storage: blobMode?'hosted_blob':'hosted_postgres', collectionMode: publication.collector.mode,
    intervalMinutes: interval, lastRunUrl: publication.collector.runUrl };
  if(blobMode)result.capacity=capacityFor(publication);
  return result;
}

function capacityFor(publication:HostedPublication){
  const cached=capacityCache.get(publication);if(cached)return cached;
  const value={publicationBytes:Buffer.byteLength(JSON.stringify(publication)),publicationLimitBytes:MAX_BLOB_PUBLICATION_BYTES as typeof MAX_BLOB_PUBLICATION_BYTES,
    networkEvents:publication.snapshot.network.events.length,networkEventLimit:100_000 as const};
  capacityCache.set(publication,value);return value;
}

async function hostedBlobStatus(publication:HostedPublication):Promise<PublicIndexerStatus>{
  const status=hostedStatus(publication),key=primaryKey()??'blob:runtime',now=Date.now();
  const failure=await cachedCollectorFailure(key,now);
  const latestAttempt=publication.checkpoints.map(c=>c.lastAttemptAt).filter((v):v is string=>v!==null).map(Date.parse);
  status.collectorFailure=failure&&(!latestAttempt.length||Date.parse(failure.failedAt)>Math.max(...latestAttempt))?{failedAt:failure.failedAt,code:failure.code}:null;
  return status;
}

async function cachedCollectorFailure(key:string,now:number):Promise<CollectorFailure|null>{
  const cached=collectorFailureCache;
  if(cached&&cached.key===key&&now-cached.checkedAt<60_000)return cached.value;
  if(collectorFailureInFlight?.key===key)return collectorFailureInFlight.promise;
  const promise=(async()=>{
    try{
      const value=await readDeadline(readCollectorFailure({token:process.env.BLOB_READ_WRITE_TOKEN}),1200);
      collectorFailureCache={key,checkedAt:Date.now(),value,unavailable:false};return value;
    }catch{
      const prior=collectorFailureCache,previous=prior&&prior.key===key?prior.value:null;
      collectorFailureCache={key,checkedAt:Date.now(),value:previous,unavailable:true};return previous;
    }
  })();
  collectorFailureInFlight={key,promise};
  try{return await promise;}finally{if(collectorFailureInFlight?.promise===promise)collectorFailureInFlight=undefined;}
}

async function readDeadline<T>(work:Promise<T>,timeoutMs=3000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('READ_TIMEOUT')),timeoutMs);})]);}finally{clearTimeout(timer);}}
/** Explicit read-only history; never copied into the current Blob publication. */
export async function getNeonHistoryState():Promise<ServingState>{
  const connection=process.env.WEB_DATABASE_URL;if(!connection)throw new DataAccessError('SOURCE_UNAVAILABLE','Neon history is not configured. Current Blob observations remain separate.',503);
  try{const state=await readDeadline(new PostgresPublicationStore(neonClient(connection),true).read());if(!state)throw new Error();
    const indexerStatus={...hostedStatus(state.publication,false),storage:'hosted_postgres' as const,historical:true};
    if(indexerStatus.publication!=='available')throw new DataAccessError('PUBLICATION_QUARANTINED','Historical observations are awaiting source reconciliation.',503);
    return{snapshot:ObservationSetSchema.parse(state.publication.snapshot),mode:'indexed_observations',indexerStatus};
  }catch(error){if(error instanceof DataAccessError)throw error;throw new DataAccessError('SOURCE_UNAVAILABLE','Neon history is currently unavailable. No historical data has been removed; current Blob observations remain separate.',503);}
}

export async function getObservationSet(): Promise<ObservationSet> { return (await getServingState()).snapshot; }
