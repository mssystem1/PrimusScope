import { resolve } from 'node:path';
import { SQLiteStore } from '@primusscope/storage';
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
}).strict();
export const PublicIndexerStatusSchema = z.object({
  mode: ServingModeSchema, storage: z.enum(['bundled_snapshot', 'local_sqlite']),
  publication: z.enum(['available', 'quarantined', 'empty']), snapshotId: Sha256Schema.nullable(),
  continuousWorker: z.literal(false), domains: z.array(PublicIndexerDomainStatusSchema).max(2),
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
]);

/** Configuration-only: no filesystem creation, SQLite open or provider access. */
export function getServingMode(): ServingMode {
  const value = process.env.PRIMUSSCOPE_DATA_MODE ?? 'recorded';
  if (value === 'recorded') return 'recorded_observations';
  if (value === 'indexed') return 'indexed_observations';
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
    })),
  });
}

/** Status remains readable when publication is quarantined. */
export function getIndexerStatus(): PublicIndexerStatus {
  if (getServingMode() === 'recorded_observations') {
    return { mode: 'recorded_observations', storage: 'bundled_snapshot', publication: 'available',
      snapshotId: bundledSnapshot().snapshotId, continuousWorker: false, domains: [] };
  }
  const store = openReadOnlyStore();
  try { return publicStatus(store.getStatus()); }
  catch { throw new DataAccessError('SOURCE_UNAVAILABLE', 'The indexer status could not be validated.', 503); }
  finally { store.close(); }
}

export function getServingState(): ServingState {
  const mode = getServingMode();
  if (mode === 'recorded_observations') return { snapshot: bundledSnapshot(), mode, indexerStatus: null };
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

export function getObservationSet(): ObservationSet { return getServingState().snapshot; }
