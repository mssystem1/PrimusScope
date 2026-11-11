import { describe, expect, it } from 'vitest';
import { FinanceStrategySchema } from '@primusscope/api-schema';
import { getObservationSet } from './serving';
import { buildFinanceComparison, buildNetworkComparison } from './comparisons';
import retainedStrategy from '../../../data/strategy/unitas-history.json';
import { decimalUnits } from './strategy-analytics';

const source = await getObservationSet();
const networkTemplates = source.network.events;

function setCoverage(snapshot: typeof source, domain: 'network' | 'finance', from: string, to: string) {
  snapshot[domain].coverage.fromTime = from;
  snapshot[domain].coverage.toTime = to;
  snapshot[domain].coverage.completeForRegisteredContracts = true;
}

function addNetworkEvent(snapshot: typeof source, kind: string, timestamp: string) {
  const event = structuredClone(networkTemplates.find(candidate => candidate.kind === kind)!);
  event.id += `-comparison-${snapshot.network.events.length}`;
  event.timestamp = timestamp;
  snapshot.network.events.push(event);
}

describe('coverage-aware period comparisons', () => {
  it('uses adjacent equal inclusive periods and counts events at both boundaries', () => {
    const snapshot = structuredClone(source);
    setCoverage(snapshot, 'network', '2026-01-01T00:00:00.000Z', '2026-01-04T23:59:59.999Z');
    snapshot.network.events = [];
    addNetworkEvent(snapshot, 'SubmitTask', '2026-01-02T00:00:00.000Z');
    addNetworkEvent(snapshot, 'SubmitTask', '2026-01-02T23:59:59.999Z');
    addNetworkEvent(snapshot, 'SubmitTask', '2026-01-03T00:00:00.000Z');
    addNetworkEvent(snapshot, 'ReportResult', '2026-01-03T23:59:59.999Z');

    const result = buildNetworkComparison(snapshot, { range: 'custom', from: '2026-01-03', to: '2026-01-03' });
    expect(result.status).toBe('available');
    expect(result.current).toMatchObject({ from: '2026-01-03T00:00:00.000Z', to: '2026-01-03T23:59:59.999Z', complete: true });
    expect(result.previous).toMatchObject({ from: '2026-01-02T00:00:00.000Z', to: '2026-01-02T23:59:59.999Z', complete: true });
    expect(result.metrics.find(item => item.key === 'SubmitTask')).toMatchObject({ current: '1', previous: '2', delta: '-1', percentChange: -50 });
  });

  it('keeps observed current values when the previous period is uncovered and suppresses its delta', () => {
    const snapshot = structuredClone(source);
    setCoverage(snapshot, 'network', '2026-01-03T00:00:00.000Z', '2026-01-03T23:59:59.999Z');
    snapshot.network.events = [];
    addNetworkEvent(snapshot, 'SubmitTask', '2026-01-03T12:00:00.000Z');
    const result = buildNetworkComparison(snapshot, { range: 'custom', from: '2026-01-03', to: '2026-01-03' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('INCOMPLETE_COVERAGE');
    expect(result.current.complete).toBe(true);
    expect(result.previous.complete).toBe(false);
    expect(result.previous.coveredFrom).toBeNull();
    expect(result.metrics.find(item => item.key === 'SubmitTask')).toMatchObject({ current: '1', previous: null, delta: null, percentChange: null });
  });

  it('preserves a covered zero and reports an undefined percentage for a zero baseline', () => {
    const snapshot = structuredClone(source);
    setCoverage(snapshot, 'network', '2026-01-01T00:00:00.000Z', '2026-01-04T23:59:59.999Z');
    snapshot.network.events = [];
    addNetworkEvent(snapshot, 'SubmitTask', '2026-01-03T12:00:00.000Z');
    const result = buildNetworkComparison(snapshot, { range: 'custom', from: '2026-01-03', to: '2026-01-03' });
    expect(result.metrics.find(item => item.key === 'ReportResult')).toMatchObject({ current: '0', previous: '0', delta: '0', percentChange: null });
  });

  it('marks all time unavailable and rejects missing timestamps or incomplete registered coverage', () => {
    const all = buildNetworkComparison(source, { range: 'all' });
    expect(all).toMatchObject({ status: 'unavailable', reason: 'NO_FIXED_PERIOD' });
    const missing = structuredClone(source);
    setCoverage(missing, 'network', '2026-01-01T00:00:00.000Z', '2026-01-04T23:59:59.999Z');
    missing.network.events[0]!.timestamp = null;
    expect(buildNetworkComparison(missing, { range: 'custom', from: '2026-01-03', to: '2026-01-03' }).reason).toBe('MISSING_TIMESTAMPS');
    const partial = structuredClone(missing);
    partial.network.events[0]!.timestamp = '2026-01-03T00:00:00.000Z';
    partial.network.coverage.completeForRegisteredContracts = false;
    expect(buildNetworkComparison(partial, { range: 'custom', from: '2026-01-03', to: '2026-01-03' }).reason).toBe('INCOMPLETE_COVERAGE');
  });

  it('uses the selected registered finance route for route-operation counts', () => {
    const snapshot = structuredClone(source);
    setCoverage(snapshot, 'finance', '2026-01-01T00:00:00.000Z', '2026-01-04T23:59:59.999Z');
    for (const event of snapshot.finance.events) event.timestamp = '2026-01-03T12:00:00.000Z';
    const routeId = snapshot.finance.contracts[0]!.routeId;
    const selected = buildFinanceComparison(snapshot, { range: 'custom', from: '2026-01-03', to: '2026-01-03', routeId });
    const all = buildFinanceComparison(snapshot, { range: 'custom', from: '2026-01-03', to: '2026-01-03' });
    const selectedCount = BigInt(selected.routeOperations.metrics[0]!.current!);
    const allCount = BigInt(all.routeOperations.metrics[0]!.current!);
    expect(selected.routeOperations.status).toBe('available');
    expect(selectedCount).toBeLessThanOrEqual(allCount);
    expect(selected.strategyFlows.current).toEqual(all.strategyFlows.current);
  });

  it('does not create a comparison when no fixed range is selected', () => {
    const result = buildFinanceComparison(source);
    expect(result.routeOperations.reason).toBe('NO_FIXED_PERIOD');
    expect(result.strategyFlows.reason).toBe('NO_FIXED_PERIOD');
  });

  it('compares shared strategy flows with exact large raw amounts and honors incoming flow coverage', () => {
    const snapshot = structuredClone(source);
    const strategy = structuredClone(FinanceStrategySchema.parse(retainedStrategy));
    const rawAmount = '9007199254740993123456789';
    const extra = structuredClone(strategy.flows[0]!);
    extra.logIndex = String(Math.max(...strategy.flows.map(flow => Number(flow.logIndex))) + 100);
    extra.blockNumber = strategy.flowCoverage!.toBlock;
    extra.timestamp = '2026-09-13T12:00:00.000Z';
    extra.kind = 'Deposit';
    extra.assetsRaw = rawAmount;
    strategy.flows.push(extra);
    snapshot.finance.strategy = strategy;

    const options = { range: 'custom' as const, from: '2026-09-13', to: '2026-09-13', routeId: 'a-route-with-no-effect-on-shared-flows' };
    const result = buildFinanceComparison(snapshot, options);
    const currentTotal = strategy.flows.filter(flow => flow.kind === 'Deposit' && flow.timestamp.startsWith('2026-09-13'))
      .reduce((total, flow) => total + BigInt(flow.assetsRaw), 0n);
    expect(result.strategyFlows.status).toBe('available');
    expect(result.strategyFlows.metrics[0]!.current).toBe(decimalUnits(String(currentTotal)));
    expect(BigInt(currentTotal)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const incomplete = structuredClone(snapshot);
    incomplete.finance.strategy!.flowCoverage!.complete = false;
    const unavailable = buildFinanceComparison(incomplete, options).strategyFlows;
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.metrics.every(item => item.current === null && item.previous === null && item.delta === null)).toBe(true);
  });
});
