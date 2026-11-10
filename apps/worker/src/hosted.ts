import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQLiteStore, StorageError } from '@primusscope/storage';
import { PostgresPublicationStore } from '@primusscope/storage/postgres';
import type { HostedPublication } from '@primusscope/storage/publication';
import type { FinanceStrategy } from '@primusscope/api-schema';
import { runOnce, DEFAULT_SCAN_LIMITS, type ScanLimits } from './indexer';
import { CurlRpc, DEFAULT_RPC_LIMITS, type Rpc } from './rpc';
import { sourceFor, WorkerError, type Domain } from './registry';

type HostedOptions = {
  store: PostgresPublicationStore;
  collector: HostedPublication['collector'];
  limits?: ScanLimits;
  rpcFor?: (domain: Domain) => Rpc;
  runDomain?: typeof runOnce;
  collectStrategy?: (previous?:FinanceStrategy)=>Promise<{strategy:FinanceStrategy;flowIssueCode?:string}>;
};

/** Job-local SQLite reuses the validated reducer; only fenced publications survive a job. */
export async function collectHosted(options: HostedOptions) {
  const token = await options.store.acquireLease('collector:' + randomUUID());
  if (!token) return { outcome: 'busy', code: 'LEASE_BUSY', reports: [] };
  let directory: string | undefined;
  let local: SQLiteStore | undefined;
  try {
    const initial = await options.store.read();
    if (!initial) throw new StorageError('NOT_INITIALIZED');
    directory = await mkdtemp(join(tmpdir(), 'primusscope-collector-'));
    local = new SQLiteStore(join(directory, 'job.sqlite'));
    local.restorePublication(initial.publication);
    let revision = initial.revision;
    const reports = [];
    for (const domain of ['finance', 'network'] as const) {
      await options.store.renewLease(token);
      try {
        const rpc = options.rpcFor?.(domain) ?? new CurlRpc(sourceFor(domain, initial.publication.snapshot).endpoint,
          { ...DEFAULT_RPC_LIMITS, maxRequests: 600, maxSeconds: 240 });
        reports.push(await (options.runDomain ?? runOnce)(local, rpc, domain, options.limits ??
          { ...DEFAULT_SCAN_LIMITS, maxBlocks: 10_000, chunkSize: domain === 'finance' ? 10_000 : 5000 }));
      } catch (error) {
        reports.push({ domain, outcome: 'failed', code: error instanceof StorageError || error instanceof WorkerError
          ? error.code : 'INDEXER_FAILED' });
      }
      if(domain==='finance'&&options.collectStrategy&&!local.getCheckpoint('finance').quarantined){
        const strategyLease=local.acquireLease('finance','strategy',120000);
        if(strategyLease)try{
          const result=await options.collectStrategy(local.readSnapshot().finance.strategy);
          local.recordStrategy(strategyLease.token,result.strategy);
          if(result.flowIssueCode)reports.push({domain:'strategy',outcome:'failed',code:result.flowIssueCode});
        }catch(error){reports.push({domain:'strategy',outcome:'failed',code:error instanceof WorkerError||error instanceof StorageError?error.code:'STRATEGY_COLLECTION_FAILED'});}
        finally{local.releaseLease(strategyLease.token);}
      }
      // Also publish safe failed-run status and completed ranges; never conceal quarantine.
      const publication = local.exportPublication(options.collector);
      await options.store.renewLease(token);
      revision = await options.store.publish(token, revision, publication);
      if (publication.checkpoints.some(c => c.quarantined)) break;
    }
    return { outcome: reports.some(r => r.outcome === 'failed') ? 'partial' : 'completed', revision, reports };
  } finally {
    local?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    try { await options.store.releaseLease(token); } catch { /* An expired owner cannot remove its successor. */ }
  }
}
