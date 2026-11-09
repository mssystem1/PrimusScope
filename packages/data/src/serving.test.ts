import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteStore } from '@primusscope/storage';
import recorded from '../../../data/observations/current.json';
import { ObservationSetSchema } from '@primusscope/api-schema';
import {
  createRepository, DataAccessError, getFreshness, getIndexerStatus, getObservationSet,
  getOverview, getServingContext, getServingMode, getServingState,
} from './index';

const seed = ObservationSetSchema.parse(recorded);
const temporary: string[] = [];
const stores: SQLiteStore[] = [];
const FINANCE_HASH = '0x' + '11'.repeat(32);
const NETWORK_HASH = '0x' + '22'.repeat(32);

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'primusscope-serving-'));
  temporary.push(directory);
  const path = join(directory, 'indexer.sqlite');
  const store = new SQLiteStore(path, { clock: () => new Date('2026-11-09T09:00:00Z') });
  stores.push(store);
  store.initialize(seed, { finance: FINANCE_HASH, network: NETWORK_HASH });
  vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'indexed');
  vi.stubEnv('PRIMUSSCOPE_DB_PATH', path);
  vi.stubEnv('VERCEL', '');
  return { store, path };
}

async function expectError(action: () => unknown, code: string) {
  await expect(Promise.resolve().then(action)).rejects.toBeInstanceOf(DataAccessError);
  try { await action(); } catch (error) { expect(error).toMatchObject({ code, status: 503 }); }
}

describe('explicit observation serving modes', () => {
  it('defaults to the immutable recorded artifact without opening a configured database', async () => {
    vi.stubEnv('PRIMUSSCOPE_DB_PATH', '/missing/private-store.sqlite');
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'recorded');
    expect((await getServingState())).toMatchObject({ mode: 'recorded_observations', indexerStatus: null });
    expect((await getObservationSet()).snapshotId).toBe(seed.snapshotId);
    expect((await getIndexerStatus())).toEqual({ mode: 'recorded_observations', storage: 'bundled_snapshot',
      publication: 'available', snapshotId: seed.snapshotId, continuousWorker: false, domains: [] });
  });

  it('reads configuration without opening SQLite, and rejects unknown modes without echo', async () => {
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'indexed');
    vi.stubEnv('PRIMUSSCOPE_DB_PATH', '/missing/private-store.sqlite');
    expect(getServingContext()).toEqual({ mode: 'indexed_observations', indexerStatus: null });
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'private-credential-value');
    await expectError(getServingMode, 'UNSUPPORTED_CONFIGURATION');
    try { getServingMode(); } catch (error) { expect(String(error)).not.toContain('private-credential-value'); }
  });

  it('never creates a missing indexed database or falls back to recorded data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'primusscope-serving-missing-'));
    temporary.push(directory);
    const path = join(directory, 'missing-parent', 'private-store.sqlite');
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'indexed');
    vi.stubEnv('PRIMUSSCOPE_DB_PATH', path);
    vi.stubEnv('VERCEL', '');
    await expectError(getServingState, 'SOURCE_UNAVAILABLE');
    expect(existsSync(join(directory, 'missing-parent'))).toBe(false);
    try { (await getServingState()); } catch (error) { expect(String(error)).not.toContain('private-store'); }
  });

  it('rejects a corrupt indexed database with a fixed public error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'primusscope-serving-corrupt-'));
    temporary.push(directory);
    const path = join(directory, 'private-store.sqlite');
    writeFileSync(path, 'private-credential-value');
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'indexed'); vi.stubEnv('PRIMUSSCOPE_DB_PATH', path); vi.stubEnv('VERCEL', '');
    await expectError(getServingState, 'SOURCE_UNAVAILABLE');
    try { (await getServingState()); } catch (error) { expect(String(error)).not.toContain('private-credential-value'); }
  });

  it('disallows local SQLite persistence on Vercel while recorded mode still works', async () => {
    database(); vi.stubEnv('VERCEL', '1');
    await expectError(getServingState, 'UNSUPPORTED_CONFIGURATION');
    await expectError(getIndexerStatus, 'UNSUPPORTED_CONFIGURATION');
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'recorded');
    expect((await getObservationSet()).snapshotId).toBe(seed.snapshotId);
  });

  it('reads a committed zero-event range immediately without a web rebuild', async () => {
    const { store } = database();
    const before = (await getServingState());
    const checkpoint = store.getCheckpoint('finance');
    const lease = store.acquireLease('finance', 'serving-test')!;
    store.commitRange('finance', lease.token, { fromBlock: checkpoint.nextBlock, toBlock: checkpoint.nextBlock,
      previousBlockHash: checkpoint.blockHash, toBlockHash: '0x' + '33'.repeat(32),
      toTime: '2026-11-09T08:00:00Z', observedAt: '2026-11-09T09:00:00Z', events: [] });
    store.recordRun('finance', lease.token, { outcome: 'advanced', at: '2026-11-09T09:00:00Z',
      targetFinalizedBlock: String(BigInt(checkpoint.nextBlock) + 20n), sourceAsOf: '2026-11-09T08:10:00Z' });
    store.releaseLease(lease.token);
    const after = (await getServingState());
    expect(after.mode).toBe('indexed_observations');
    expect(after.snapshot.snapshotId).not.toBe(before.snapshot.snapshotId);
    expect(after.snapshot.finance.events).toHaveLength(9);
    expect(after.snapshot.finance.coverage.toBlock).toBe(checkpoint.nextBlock);
    expect(after.indexerStatus?.domains.find(domain => domain.domain === 'finance'))
      .toMatchObject({ lastOutcome: 'advanced', lagBlocks: '20', lastSuccessAt: '2026-11-09T09:00:00.000Z' });
    expect((await getOverview()).mode).toBe('indexed_observations');
    expect(getFreshness(after.snapshot.finance.coverage, new Date('2026-11-09T09:00:00Z'), after.mode))
      .toMatchObject({ mode: 'indexed_observations', state: 'fresh', sourceAsOf: '2026-11-09T08:00:00.000Z' });
  });

  it('retains publication and source times on failed polling and reports a safe issue', async () => {
    const { store } = database();
    const before = (await getServingState());
    const lease = store.acquireLease('finance', 'serving-test')!;
    store.recordRun('finance', lease.token, { outcome: 'failed', at: '2026-11-09T09:00:00Z', code: 'RPC_TIMEOUT', retryAfterSeconds: 120 });
    store.releaseLease(lease.token);
    const after = (await getServingState());
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.indexerStatus?.domains.find(domain => domain.domain === 'finance'))
      .toMatchObject({ lastOutcome: 'failed', lastErrorCode: 'RPC_TIMEOUT', lastSuccessAt: null,
        observedAt: seed.finance.coverage.observedAt, retryAfterSeconds: 120, nextRetryAt: '2026-11-09T09:02:00.000Z' });
    expect(JSON.stringify(after.indexerStatus)).not.toContain('serving-test');
    expect(JSON.stringify(after.indexerStatus)).not.toContain('indexer.sqlite');
  });

  it('keeps operational status available while refusing quarantined observations', async () => {
    const { store } = database(); const lease = store.acquireLease('network', 'serving-test')!;
    store.quarantine('network', lease.token, 'REORG_DETECTED'); store.releaseLease(lease.token);
    await expectError(getServingState, 'PUBLICATION_QUARANTINED');
    const status = (await getIndexerStatus());
    expect(status.publication).toBe('quarantined');
    expect(status.domains.find(domain => domain.domain === 'network'))
      .toMatchObject({ quarantined: true, lastErrorCode: 'REORG_DETECTED' });
  });
});

describe('appended observation semantics', () => {
  it('does not let an older native sample override a later lifecycle event', async () => {
    const input = structuredClone(seed);
    const native = input.finance.stateSamples[0]!;
    const finalized = input.finance.events.find(event => event.kind === 'AggregateFinalized'
      && event.contractAddress === native.contractAddress && event.batchId === native.batchId)!;
    native.nativeStateCode = 1;
    native.asOfBlock = String(BigInt(finalized.blockNumber) - 1n);
    const batch = createRepository(input).getFinanceBatch(native.contractAddress, native.batchId);
    expect(batch.nativeState).toMatchObject({ code: 1, name: 'Dispatched', asOfBlock: native.asOfBlock });
    expect(batch).toMatchObject({ observedState: 'Finalized', stateOrigin: 'event_observation' });
  });

  it('labels CSV and source freshness with indexed mode without implying a continuous worker', async () => {
    const { store } = database();
    const context = { mode: 'indexed_observations' as const, indexerStatus: (await getIndexerStatus()) };
    const repository = createRepository(store.readSnapshot(), () => new Date('2026-11-09T09:00:00Z'), context);
    const sources = repository.getSources();
    expect(sources.items.filter(source => source.status === 'indexed')).toHaveLength(2);
    expect(sources.mode).toBe('indexed_observations');
    expect(sources.indexerStatus?.continuousWorker).toBe(false);
    const csv = repository.exportMetricsCsv({ domain: 'finance' });
    expect(csv.split('\r\n')[0]).toContain('data_mode');
    expect(csv).toContain('indexed_observations');
  });
});
