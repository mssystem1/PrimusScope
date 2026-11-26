import { timingSafeEqual } from 'node:crypto';
import { collectHosted } from '@primusscope/worker/hosted';
import { FetchRpc } from '@primusscope/worker/fetch-rpc';
import { collectPublicStrategy } from '@primusscope/worker/strategy';
import { StorageError } from '@primusscope/storage';
import { neonClient, PostgresPublicationStore } from '@primusscope/storage/postgres';
import {SDKDiagnosticsStore} from '@primusscope/storage/diagnostics';
import{BlobPublicationStore}from'@primusscope/storage/blob';
import{recordCollectorFailure}from'@primusscope/storage/collector-status';
import{freshPublication}from'@primusscope/worker/seed';
import recorded from'../../../../../../data/observations/current.json';
import{ObservationSetSchema}from'@primusscope/api-schema';
import { verifyRecoveryToken } from '../../../recovery-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization') ?? '';
  const expected = secret ? Buffer.from('Bearer ' + secret) : Buffer.alloc(0);
  const actual = Buffer.from(authorization);
  const headers = { 'Cache-Control': 'no-store' };
  const cronAuthorized = !!secret && secret.length >= 40 && actual.length === expected.length && timingSafeEqual(actual, expected);
  const recoveryIdentity = !cronAuthorized && authorization.startsWith('Bearer ')
    ? await verifyRecoveryToken(authorization.slice(7)) : null;
  if (!cronAuthorized && !recoveryIdentity) {
    return Response.json({ code: 'UNAUTHORIZED' }, { status: 401, headers });
  }
  if (new URL(request.url).search) return Response.json({ code: 'INVALID_REQUEST' }, { status: 400, headers });
  const connection = process.env.WORKER_DATABASE_URL;
  const blob=process.env.PRIMUSSCOPE_PUBLICATION_STORE==='blob';
  if (!blob&&process.env.PRIMUSSCOPE_NEON_HISTORY_ONLY==='1') return Response.json({code:'HISTORY_READ_ONLY'},{status:503,headers});
  if (!blob&&!connection) return Response.json({ code: 'DATABASE_NOT_CONFIGURED' }, { status: 503, headers });
  const started = Date.now();
  const strategyEnabled = process.env.PRIMUSSCOPE_STRATEGY_ENABLED === '1';
  try {
    const store = blob?new BlobPublicationStore({token:process.env.BLOB_READ_WRITE_TOKEN}):new PostgresPublicationStore(neonClient(connection!));
    const recoveryRun=request.headers.get('x-primusscope-recovery-run');
    const runUrl=recoveryIdentity?.runUrl??(recoveryRun&&/^https:\/\/github\.com\/mssystem1\/PrimusScope\/actions\/runs\/[0-9]+$/.test(recoveryRun)?recoveryRun:null);
    const collector={mode:'scheduled' as const,provider:'vercel_cron' as const,intervalMinutes:blob?60:15,runUrl};
    const rpcFor=(domain:'finance'|'network')=>new FetchRpc(
      domain==='finance'?'https://bsc-rpc.publicnode.com':'https://base-rpc.publicnode.com', {
        // Hourly collection must cover more than 10,000 Base blocks. Keep the
        // shared deadline and response limits; pace reads at at most 8/sec.
        maxRequests:blob?2000:600,
        maxSeconds:Math.max(15,Math.min(strategyEnabled&&domain==='finance'?110:220,
          Math.floor((240000-(Date.now()-started))/1000))),
        timeoutSeconds:10,maxResponseBytes:2000000,minIntervalMs:blob?125:350,
      });
    if(blob&&!await store.read()){
      const seed=await freshPublication(ObservationSetSchema.parse(recorded),rpcFor,collector);
      try{await (store as BlobPublicationStore).initialize(seed);}catch(error){if(!(error instanceof StorageError)||error.code!=='SEED_MISMATCH')throw error;}
    }
    const result = await collectHosted({ store,
      commitOnce:blob,
      ...(strategyEnabled ? { collectStrategy: collectPublicStrategy } : {}),
      collector,
      ...(blob?{limits:{maxBlocks:40000,chunkSize:5000,maxEventsPerChunk:250,leaseMs:600000}}:{}),
      rpcFor,
    });
    // Independent metadata retention must not roll back completed chain work.
    let retention=blob?'history_read_only':'unavailable';
    if(!blob)try{await new SDKDiagnosticsStore(neonClient(connection!)).prune();retention='pruned';}catch{}
    return Response.json(result, { status: result.outcome === 'partial' ? 207 : 200, headers:{...headers,'X-PrimusScope-Diagnostics-Retention':retention} });
  } catch (error) {
    if(blob){
      const code=error instanceof StorageError?error.code:'COLLECTION_FAILED';
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([recordCollectorFailure(code,{token:process.env.BLOB_READ_WRITE_TOKEN}),new Promise<void>(resolve=>{timer=setTimeout(resolve,2500);})]);}catch{/* Failure status is best-effort; preserve the original collection error. */}finally{if(timer)clearTimeout(timer);}
    }
    return Response.json({ code: error instanceof StorageError ? error.code : 'COLLECTION_FAILED' }, { status: 503, headers });
  }
}
