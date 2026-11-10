import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ObservationSetSchema } from '@primusscope/api-schema';
import { SQLiteStore } from '@primusscope/storage';
import { PostgresPublicationStore } from '@primusscope/storage/postgres';
import recorded from '../../../data/observations/current.json';
import strategyJson from '../../../data/strategy/unitas-history.json';
import { FinanceStrategySchema } from '@primusscope/api-schema';
import { collectHosted } from './hosted';
import type { runOnce, RunReport } from './indexer';

let database: PGlite;
// PostgreSQL/WASM cold start and durable restart exercise real I/O.
vi.setConfig({testTimeout:15000});
afterEach(async () => { await database?.close(); });
async function fixture() {
  database = new PGlite();
  const store = new PostgresPublicationStore({ async query(sql, values = []) {
    return { rows: (await database.query<Record<string, unknown>>(sql, values)).rows };
  } });
  await store.migrate();
  const directory = mkdtempSync(join(tmpdir(), 'primusscope-hosted-seed-'));
  const local = new SQLiteStore(join(directory, 'seed.sqlite'));
  try {
    local.initialize(ObservationSetSchema.parse(recorded), { finance: '0x' + '11'.repeat(32), network: '0x' + '22'.repeat(32) });
    await store.initialize(local.exportPublication());
  } finally { local.close(); rmSync(directory, { recursive: true, force: true }); }
  return store;
}
const collector = { mode: 'scheduled', provider: 'vercel_cron', intervalMinutes: 15, runUrl: null } as const;
const rpcFor = () => ({ requestsMade: 0, async call() { throw new Error('Unexpected RPC'); } });
const advance: typeof runOnce = async (store, _rpc, domain) => {
  const current = store.getCheckpoint(domain), token = store.acquireLease(domain, 'test')!.token;
  const toBlock = String(BigInt(current.toBlock) + 1n), at = new Date().toISOString();
  store.commitRange(domain, token, { fromBlock: toBlock, toBlock, previousBlockHash: current.blockHash,
    toBlockHash: '0x' + '33'.repeat(32), toTime: new Date(Date.parse(current.toTime) + 1000).toISOString(), observedAt: at, events: [] });
  store.recordRun(domain, token, { outcome: 'advanced', at, targetFinalizedBlock: toBlock,
    sourceAsOf: new Date(Date.parse(current.toTime) + 1000).toISOString() });
  store.releaseLease(token);
  return { domain, outcome: 'advanced', toBlock } as RunReport;
};

it('retains strategy observations through the next domain commit and a fresh collector job',async()=>{
  const store=await fixture(),strategy=FinanceStrategySchema.parse(strategyJson);
  await collectHosted({store,collector,rpcFor,runDomain:advance,collectStrategy:async()=>({strategy})});
  expect((await store.read())?.publication.snapshot.finance.strategy).toEqual(strategy);
  await collectHosted({store,collector,rpcFor,runDomain:advance});
  expect((await store.read())?.publication.snapshot.finance.strategy).toEqual(strategy);
});

it('persists a completed domain before a later failure and resumes in a fresh job', async () => {
  const store = await fixture(), before = (await store.read())!;
  const first = await collectHosted({ store, collector, rpcFor, runDomain: async (...args) => {
    if (args[2] === 'network') throw new Error('provider response with private payload');
    return advance(...args);
  } });
  expect(first).toMatchObject({ outcome: 'partial', revision: '2' });
  expect(JSON.stringify(first)).not.toContain('private payload');
  const middle = (await store.read())!;
  expect(BigInt(middle.publication.snapshot.finance.coverage.toBlock)).toBe(BigInt(before.publication.snapshot.finance.coverage.toBlock) + 1n);
  expect(middle.publication.snapshot.network.coverage).toEqual(before.publication.snapshot.network.coverage);
  await collectHosted({ store, collector, rpcFor, runDomain: advance });
  const after = (await store.read())!;
  expect(BigInt(after.publication.snapshot.finance.coverage.toBlock)).toBe(BigInt(before.publication.snapshot.finance.coverage.toBlock) + 2n);
  expect(BigInt(after.publication.snapshot.network.coverage.toBlock)).toBe(BigInt(before.publication.snapshot.network.coverage.toBlock) + 1n);
  expect(after.publication.collector).toEqual(collector);
});
it('makes no reducer or provider calls while another collector owns the database lease', async () => {
  const store = await fixture(); await store.acquireLease('other-job');
  let calls = 0;
  expect(await collectHosted({ store, collector, rpcFor: () => { calls++; return rpcFor(); }, runDomain: advance }))
    .toMatchObject({ outcome: 'busy', code: 'LEASE_BUSY' });
  expect(calls).toBe(0); expect((await store.read())?.revision).toBe('0');
});
it('publishes quarantine and stops before the next domain', async () => {
  const store = await fixture(); let domains = 0;
  const result = await collectHosted({ store, collector, rpcFor, runDomain: async (local, _rpc, domain) => {
    domains++; const lease = local.acquireLease(domain, 'test')!;
    local.quarantine(domain, lease.token, 'CHECKPOINT_HASH_CHANGED'); local.releaseLease(lease.token);
    return { domain, outcome: 'failed', code: 'CHECKPOINT_HASH_CHANGED' } as RunReport;
  } });
  expect(result.outcome).toBe('partial'); expect(domains).toBe(1);
  expect((await store.read())?.publication.checkpoints[0]?.quarantined).toBe(true);
});
