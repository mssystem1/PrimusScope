import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FinanceStrategySchema, ObservationSetSchema } from '@primusscope/api-schema';
import { SQLiteStore } from '@primusscope/storage';
import recorded from '../../../data/observations/current.json';
import strategy from '../../../data/strategy/unitas-history.json';
import { prependFinanceHistory, type FinanceHistory } from './finance-history';

const now = '2026-11-28T12:00:00.000Z';
const source = { id: 'bsc-history-archive', label: 'BSC archive', kind: 'rpc', url: 'https://bsc.rpc.sentio.xyz' } as const;

function fixture() {
  const input = ObservationSetSchema.parse(recorded);
  const event = input.finance.events[0]!;
  input.finance.coverage.fromBlock = event.blockNumber;
  input.finance.coverage.fromTime = event.timestamp;
  input.finance.events = [event];
  input.finance.strategy = FinanceStrategySchema.parse(strategy);
  const directory = mkdtempSync(join(tmpdir(), 'primusscope-finance-history-'));
  const store = new SQLiteStore(join(directory, 'history.sqlite'), { clock: () => new Date(now) });
  try {
    store.initialize(input, { finance: '0x' + '11'.repeat(32), network: '0x' + '22'.repeat(32) });
    const lease = store.acquireLease('finance', 'test')!;
    const checkpoint = store.getCheckpoint('finance');
    store.recordRun('finance', lease.token, {
      at: now, outcome: 'idle', targetFinalizedBlock: checkpoint.toBlock, sourceAsOf: checkpoint.toTime,
    });
    store.releaseLease(lease.token);
    const current = store.exportPublication();
    const history: FinanceHistory = {
      fromBlock: String(BigInt(event.blockNumber) - 1n),
      fromTime: new Date(Date.parse(event.timestamp!) - 1000).toISOString(),
      toBlock: event.blockNumber,
      toTime: event.timestamp!,
      complete: true,
      source,
      events: [],
    };
    history.events = [
      { ...event, id: 'archive:duplicate-boundary', sourceId: source.id },
      {
        ...event, id: 'archive:historical', sourceId: source.id, blockNumber: history.fromBlock,
        timestamp: history.fromTime, transactionHash: '0x' + '33'.repeat(32), blockHash: '0x' + '44'.repeat(32),
      },
    ];
    return { current, history };
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

it('extends only the Finance history start, retaining published event IDs and both source records', () => {
  const { current, history } = fixture();
  const publicationTime = '2026-11-28T12:00:01.000Z';
  const result = prependFinanceHistory(current, history, publicationTime);
  const { snapshotId, ...body } = result.snapshot;
  expect(snapshotId).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  expect(result.snapshot).toMatchObject({
    generatedAt: publicationTime,
    finance: {
      ...current.snapshot.finance,
      coverage: {
        ...current.snapshot.finance.coverage, fromBlock: history.fromBlock, fromTime: history.fromTime,
        additionalSourceIds: [source.id],
      },
      events: [history.events[1], ...current.snapshot.finance.events],
    },
    network: current.snapshot.network,
    sources: [...current.snapshot.sources, source],
  });
  expect(result.checkpoints).toEqual(current.checkpoints.map(checkpoint => checkpoint.domain === 'finance'
    ? { ...checkpoint, fromBlock: history.fromBlock } : checkpoint));
  expect(result.collector).toEqual(current.collector);
  expect(current.snapshot.finance.coverage.fromBlock).toBe(history.toBlock);
  expect(current.snapshot.sources).not.toContainEqual(source);
});

it('rejects gaps, incorrect join dates, and conflicting event data', () => {
  const { current, history } = fixture();
  const reject = (value: FinanceHistory, code: string) => expect(() => prependFinanceHistory(current, value, now))
    .toThrowError(expect.objectContaining({ code }));
  reject({ ...history, toBlock: history.fromBlock }, 'FINANCE_HISTORY_BOUNDARY_MISMATCH');
  reject({ ...history, toTime: history.fromTime }, 'FINANCE_HISTORY_BOUNDARY_MISMATCH');
  reject({ ...history, events: [{ ...history.events[0]!, batchId: '42' }] }, 'FINANCE_HISTORY_EVENT_CONFLICT');
  reject({ ...history, events: [{ ...history.events[1]!, blockNumber: String(BigInt(history.fromBlock) - 1n) }] }, 'INVALID_FINANCE_HISTORY_EVENT');
  reject({ ...history, events: [{ ...history.events[1]!, contractAddress: '0x' + 'ab'.repeat(20) }] }, 'INVALID_FINANCE_HISTORY_EVENT');
});

it('requires an exact event set throughout the inclusive overlap', () => {
  const { current, history } = fixture();
  const [boundary, earlier] = history.events;
  const overlapMismatch = expect.objectContaining({ code: 'FINANCE_HISTORY_OVERLAP_MISMATCH' });
  expect(() => prependFinanceHistory(current, { ...history, events: [earlier!] }, now)).toThrowError(overlapMismatch);
  const extra = { ...boundary!, id: 'archive:unknown-boundary', logIndex: String(BigInt(boundary!.logIndex) + 1n) };
  expect(() => prependFinanceHistory(current, { ...history, events: [...history.events, extra] }, now)).toThrowError(overlapMismatch);
});

it('rejects credential-bearing sources and source ID collisions', () => {
  const { current, history } = fixture();
  const credentialSource = { ...source, url: 'https://bsc.rpc.sentio.xyz?token=example' };
  expect(() => prependFinanceHistory(current, { ...history, source: credentialSource }, now))
    .toThrowError(expect.objectContaining({ code: 'INVALID_FINANCE_HISTORY_SOURCE' }));
  const duplicate = { ...source, id: current.snapshot.finance.coverage.sourceId };
  expect(() => prependFinanceHistory(current, { ...history, source: duplicate }, now))
    .toThrowError(expect.objectContaining({ code: 'FINANCE_HISTORY_SOURCE_COLLISION' }));
});
