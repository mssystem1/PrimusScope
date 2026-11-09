import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import seedJson from '../../../data/observations/current.json';
import { ObservationSetSchema, type FinanceEvent } from '@primusscope/api-schema';
import { SQLiteStore, StorageError, defaultDatabasePath, type CompletedRange } from './index';

const seed = ObservationSetSchema.parse(seedJson);
const H = (digit: string) => '0x' + digit.repeat(64);
const anchors = { finance: H('1'), network: H('2') };
const resources: { path: string; stores: SQLiteStore[] }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    for (const store of resource.stores) try { store.close(); } catch { /* Already closed. */ }
    rmSync(resource.path, { recursive: true, force: true });
  }
});

function fixture(initialized = true) {
  const path = mkdtempSync(join(tmpdir(), 'primusscope-storage-'));
  const database = join(path, '.local', 'indexer.sqlite');
  let milliseconds = Date.parse('2026-11-09T10:00:00Z');
  const clock = () => new Date(milliseconds);
  const store = new SQLiteStore(database, { clock });
  const resource = { path, stores: [store] }; resources.push(resource);
  if (initialized) store.initialize(seed, anchors);
  return { store, database, clock, tick: (ms: number) => { milliseconds += ms; },
    open: (readOnly = false) => {
      const next = new SQLiteStore(database, { clock, readOnly }); resource.stores.push(next); return next;
    } };
}

function nextRange(store: SQLiteStore, domain: 'finance' | 'network' = 'finance', newHash = H('3')): CompletedRange {
  const checkpoint = store.getCheckpoint(domain);
  return { fromBlock: checkpoint.nextBlock, toBlock: checkpoint.nextBlock,
    previousBlockHash: checkpoint.blockHash, toBlockHash: newHash,
    toTime: new Date(Date.parse(checkpoint.toTime) + 1000).toISOString(),
    observedAt: '2026-11-09T10:00:00.000Z', events: [] };
}

function eventAt(range: CompletedRange, suffix = 'a'): FinanceEvent {
  const source = seed.finance.events[0]!;
  const transactionHash = H(suffix);
  return { ...source, id: `56:${source.contractAddress}:${transactionHash}:0`, transactionHash,
    blockNumber: range.fromBlock, blockHash: range.toBlockHash, logIndex: '0', timestamp: range.toTime, batchId: '999' };
}

function fails(code: string, action: () => unknown) {
  try { action(); throw new Error('Expected storage error'); }
  catch (error) { expect(error).toBeInstanceOf(StorageError); expect((error as StorageError).code).toBe(code); }
}

describe('durable SQLite observation storage', () => {
  it('uses one shared local default, initializes exact seed and retains source times', () => {
    const { store, database } = fixture();
    expect(defaultDatabasePath('/workspace/PrimusScope')).toBe('/workspace/PrimusScope/.local/indexer.sqlite');
    expect(store.readSnapshot()).toEqual(seed);
    expect(store.initialize(seed, anchors)).toBe(false);
    fails('ANCHOR_MISMATCH', () => store.initialize(seed, { ...anchors, finance: H('4') }));
    const status = store.getStatus();
    expect(status.publication).toBe('available');
    expect(status.domains.every(domain => domain.lastOutcome === null)).toBe(true);
    expect(status.domains.every(domain => domain.targetFinalizedBlock === null)).toBe(true);
    expect(statSync(database).mode & 0o777).toBe(0o600);
  });

  it('read-only opens neither create absent files nor mutate empty initialized schema', () => {
    const { store, database, open } = fixture(false);
    fails('SOURCE_UNAVAILABLE', () => new SQLiteStore(database + '.absent', { readOnly: true }));
    const reader = open(true);
    expect(reader.getStatus().publication).toBe('empty');
    fails('NOT_INITIALIZED', () => reader.readSnapshot());
    fails('READ_ONLY', () => reader.initialize(seed, anchors));
    store.initialize(seed, anchors);
    expect(reader.readSnapshot().snapshotId).toBe(seed.snapshotId);
  });

  it('commits empty ranges, changes snapshot identity and reads changes without rebuild', () => {
    const { store, open } = fixture(); const reader = open(true);
    const lease = store.acquireLease('finance', 'worker-1')!;
    const range = nextRange(store);
    const result = store.commitRange('finance', lease.token, range);
    expect(result.insertedEvents).toBe(0);
    expect(result.idempotent).toBe(false);
    expect(result.snapshotId).not.toBe(seed.snapshotId);
    const snapshot = reader.readSnapshot();
    expect(snapshot.finance.coverage.toBlock).toBe(range.toBlock);
    expect(snapshot.finance.events).toEqual(seed.finance.events);
    expect(snapshot.finance.stateSamples).toEqual(seed.finance.stateSamples);
    expect(snapshot.network).toEqual(seed.network);
    expect(snapshot.finance.coverage.observedAt).toBe(range.observedAt);
    expect(store.commitRange('finance', lease.token, { ...range, observedAt: '2026-11-09T10:00:01Z' }).idempotent).toBe(true);
    expect(reader.readSnapshot().snapshotId).toBe(result.snapshotId);
    fails('RANGE_CONFLICT', () => store.commitRange('finance', lease.token, { ...range, toBlockHash: H('4') }));
  });

  it('upserts a completed event range once and survives closing/reopening', () => {
    const { store, open } = fixture();
    const lease = store.acquireLease('finance', 'worker-1')!; const range = nextRange(store);
    range.events = [eventAt(range)];
    const result = store.commitRange('finance', lease.token, range);
    expect(result.insertedEvents).toBe(1);
    expect(store.readSnapshot().finance.events).toHaveLength(seed.finance.events.length + 1);
    store.releaseLease(lease.token); store.close();
    const resumed = open();
    expect(resumed.getCheckpoint('finance').toBlock).toBe(range.toBlock);
    expect(resumed.readSnapshot().snapshotId).toBe(result.snapshotId);
    expect(resumed.acquireLease('finance', 'worker-2')).not.toBeNull();
  });

  it('rejects gaps, wrong previous hashes, foreign/private fields and out-of-range logs without advancing', () => {
    const { store } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    const range = nextRange(store); const checkpoint = store.getCheckpoint('finance');
    fails('CHECKPOINT_MISMATCH', () => store.commitRange('finance', lease.token, { ...range, fromBlock: String(BigInt(range.fromBlock) + 1n), toBlock: String(BigInt(range.toBlock) + 1n) }));
    fails('CHECKPOINT_MISMATCH', () => store.commitRange('finance', lease.token, { ...range, previousBlockHash: H('4') }));
    const event = eventAt(range);
    fails('INVALID_RANGE', () => store.commitRange('finance', lease.token, { ...range, events: [{ ...event, blockNumber: String(BigInt(range.toBlock) + 1n) }] }));
    fails('INVALID_OBSERVATION', () => store.commitRange('finance', lease.token, { ...range, events: [{ ...event, decryptedBalance: 'private-secret' } as FinanceEvent] }));
    fails('INVALID_OBSERVATION', () => store.commitRange('finance', lease.token, { ...range, events: [{ ...event, contractAddress: '0x' + 'a'.repeat(40) }] }));
    expect(store.getCheckpoint('finance')).toEqual(checkpoint);
    expect(store.readSnapshot()).toEqual(seed);
  });

  it('rolls back SQL write failures together with facts/checkpoint/publication', () => {
    const { store, database } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    const raw = new DatabaseSync(database);
    raw.exec("CREATE TRIGGER fail_ranges BEFORE INSERT ON ranges BEGIN SELECT RAISE(ABORT, 'simulated'); END");
    const range = nextRange(store); range.events = [eventAt(range)];
    fails('SOURCE_UNAVAILABLE', () => store.commitRange('finance', lease.token, range));
    expect(store.readSnapshot()).toEqual(seed);
    expect(store.getCheckpoint('finance').toBlock).toBe(seed.finance.coverage.toBlock);
    const row = raw.prepare('SELECT count(*) AS total FROM events WHERE domain=?').get('finance')!;
    expect(row.total).toBe(seed.finance.events.length); raw.close();
  });

  it('pauses at bounded snapshot capacity without truncation or watermark changes', () => {
    const { store } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    const range = nextRange(store); range.events = Array(100_001).fill(eventAt(range));
    fails('CAPACITY_EXCEEDED', () => store.commitRange('finance', lease.token, range));
    expect(store.readSnapshot()).toEqual(seed);
    expect(store.getCheckpoint('finance').toBlock).toBe(seed.finance.coverage.toBlock);
  });

  it('leases fence expired writers across processes and tokens cannot release a successor', () => {
    const { store, open, tick } = fixture(); const second = open();
    const firstLease = store.acquireLease('finance', 'worker-1', 1000)!;
    expect(second.acquireLease('finance', 'worker-2')).toBeNull();
    tick(1001); const successor = second.acquireLease('finance', 'worker-2')!;
    fails('LEASE_LOST', () => store.commitRange('finance', firstLease.token, nextRange(store)));
    store.releaseLease(firstLease.token);
    expect(store.acquireLease('finance', 'worker-3')).toBeNull();
    expect(second.renewLease(successor.token).owner).toBe('worker-2');
    second.commitRange('finance', successor.token, nextRange(second));
  });

  it('serializes domain updates without losing the other domain publication', () => {
    const { store, open } = fixture(); const second = open();
    const finance = store.acquireLease('finance', 'finance-worker')!;
    const network = second.acquireLease('network', 'network-worker')!;
    const financeRange = nextRange(store, 'finance'); const networkRange = nextRange(second, 'network', H('4'));
    store.commitRange('finance', finance.token, financeRange);
    second.commitRange('network', network.token, networkRange);
    const state = store.readServingState();
    expect(state.snapshot.finance.coverage.toBlock).toBe(financeRange.toBlock);
    expect(state.snapshot.network.coverage.toBlock).toBe(networkRange.toBlock);
    expect(state.status.snapshotId).toBe(state.snapshot.snapshotId);
  });

  it('records idle, failure, lag and bounded retry-after without refreshing source coverage', () => {
    const { store } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    store.recordRun('finance', lease.token, { outcome: 'idle', at: '2026-11-09T10:00:00Z',
      targetFinalizedBlock: String(BigInt(seed.finance.coverage.toBlock) + 100n), sourceAsOf: '2026-11-09T09:59:00Z' });
    store.recordRun('finance', lease.token, { outcome: 'failed', at: '2026-11-09T10:00:01Z', code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    const status = store.getStatus().domains.find(domain => domain.domain === 'finance')!;
    expect(status.lastOutcome).toBe('failed'); expect(status.lastErrorCode).toBe('RATE_LIMITED');
    expect(status.lastSuccessAt).toBe('2026-11-09T10:00:00.000Z'); expect(status.lagBlocks).toBe('100');
    expect(status.asObservedAt).toBe('2026-11-09T10:00:00.000Z'); expect(status.retryAfterSeconds).toBe(60);
    expect(status.nextRetryAt).toBe('2026-11-09T10:01:01.000Z');
    expect(store.readSnapshot()).toEqual(seed);
    store.recordRun('finance', lease.token, { outcome: 'failed', at: '2026-11-09T10:00:02Z', code: 'https://secret.invalid/key' });
    expect(store.getStatus().domains[0]!.lastErrorCode).toBe('INDEXING_FAILED');
    fails('INVALID_RUN', () => store.recordRun('finance', lease.token, { outcome: 'failed', at: '2026-11-09T10:00:03Z', retryAfterSeconds: 86_401 }));
  });

  it('quarantines changed anchors and exposes safe status while public data is unavailable', () => {
    const { store, open } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    store.quarantine('finance', lease.token, 'CHECKPOINT_HASH_CHANGED');
    expect(open(true).getStatus().publication).toBe('quarantined');
    fails('SOURCE_QUARANTINED', () => store.readSnapshot());
    fails('SOURCE_QUARANTINED', () => store.commitRange('finance', lease.token, nextRange(store)));
  });

  it('rewinds only verified stored boundaries, removes orphaned facts, and changes publication identity', () => {
    const { store } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    const first = nextRange(store); first.events = [eventAt(first, 'a')];
    const firstId = store.commitRange('finance', lease.token, first).snapshotId;
    const second = nextRange(store, 'finance', H('4')); second.events = [eventAt(second, 'b')];
    store.commitRange('finance', lease.token, second);
    store.quarantine('finance', lease.token);
    const result = store.rollback('finance', lease.token, first.toBlock, first.toBlockHash, first.toTime);
    expect(result.snapshotId).not.toBe(firstId);
    expect(store.readSnapshot().finance.events).toHaveLength(seed.finance.events.length + 1);
    expect(store.readSnapshot().finance.events.some(event => event.transactionHash === H('b'))).toBe(false);
    expect(store.readSnapshot().finance.stateSamples).toEqual(seed.finance.stateSamples);
    expect(store.getStatus().publication).toBe('available');
    const seedResult = store.rollback('finance', lease.token, seed.finance.coverage.toBlock, anchors.finance, seed.finance.coverage.toTime);
    expect(seedResult.snapshotId).not.toBe(seed.snapshotId);
    expect(store.readSnapshot().finance.events).toEqual(seed.finance.events);
  });

  it('quarantines rollback below the seeded or unrecorded boundary', () => {
    const { store } = fixture(); const lease = store.acquireLease('finance', 'worker-1')!;
    fails('REORG_BELOW_CHECKPOINT', () => store.rollback('finance', lease.token,
      String(BigInt(seed.finance.coverage.toBlock) - 1n), H('4'), seed.finance.coverage.toTime));
    expect(store.getCheckpoint('finance').toBlock).toBe(seed.finance.coverage.toBlock);
    expect(store.getStatus().publication).toBe('quarantined');
    fails('SOURCE_QUARANTINED', () => store.readSnapshot());
  });
});
