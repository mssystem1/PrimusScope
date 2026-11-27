import type { PublicIndexerStatus } from '@primusscope/data';
import { describe, expect, it } from 'vitest';
import { getCollectionSchedule } from './collection-schedule';

const dateTime = (time: string) => `2026-11-27T${time}:00Z`;
const at = (time: string) => Date.parse(dateTime(time));

const finance: PublicIndexerStatus['domains'][number] = {
  domain: 'finance', chainId: 56, fromBlock: '1', toBlock: '2', nextBlock: '3',
  toTime: dateTime('02:59'), observedAt: dateTime('03:00'), quarantined: false,
  lastAttemptAt: dateTime('03:00'), lastSuccessAt: dateTime('03:00'), lastOutcome: 'advanced',
  lastErrorCode: null, targetFinalizedBlock: null, sourceAsOf: null, lagBlocks: null,
  asObservedAt: null, retryAfterSeconds: null, nextRetryAt: null, stale: false,
};
const status: PublicIndexerStatus = {
  mode: 'indexed_observations', storage: 'hosted_blob', publication: 'available',
  snapshotId: 'a'.repeat(64), continuousWorker: false, collectionMode: 'scheduled',
  intervalMinutes: 60, domains: [finance, { ...finance, domain: 'network', chainId: 8453 }],
};

describe('hourly collection schedule', () => {
  it('shows the next clock hour while the current slot has a recorded attempt', () => {
    expect(getCollectionSchedule(status, at('03:54'))).toEqual({
      intervalMinutes: 60, needsAttention: false, label: 'Next scheduled collection', scheduledAt: at('04:00'),
    });
  });

  it('shows the current slot while the page awaits its publication', () => {
    expect(getCollectionSchedule(status, at('04:03'))).toMatchObject({
      label: 'Update window', scheduledAt: at('04:00'), needsAttention: false,
    });
    expect(getCollectionSchedule(status, at('04:15'))).toMatchObject({
      label: 'Awaiting scheduled publication', scheduledAt: at('04:00'), needsAttention: false,
    });
  });

  it('uses the latest recorded attempt across both domains', () => {
    const domains = [finance, { ...status.domains[1]!, lastAttemptAt: dateTime('04:01') }];
    expect(getCollectionSchedule({ ...status, domains }, at('04:03'))).toMatchObject({
      label: 'Next scheduled collection', scheduledAt: at('05:00'), needsAttention: false,
    });
  });

  it.each<Partial<PublicIndexerStatus>>([
    { collectorFailure: { code: 'COLLECTION_FAILED', failedAt: dateTime('04:02') } },
    { domains: [{ ...finance, lastOutcome: 'failed' }] },
    { domains: [{ ...finance, stale: true }] },
    { domains: [{ ...finance, quarantined: true }] },
    { publication: 'quarantined' },
    { recovery: { source: 'process_cache', issue: 'PRIMARY_STORE_UNAVAILABLE' } },
  ])('flags collection that needs attention (%j)', patch => {
    expect(getCollectionSchedule({ ...status, ...patch }, at('04:03'))).toMatchObject({
      label: 'Next scheduled collection', scheduledAt: at('05:00'), needsAttention: true,
    });
  });

  it('skips manual collections and historical stores', () => {
    expect(getCollectionSchedule({ ...status, collectionMode: 'manual', intervalMinutes: null }, at('04:03'))).toBeNull();
    expect(getCollectionSchedule({ ...status, historical: true }, at('04:03'))).toBeNull();
  });
});
