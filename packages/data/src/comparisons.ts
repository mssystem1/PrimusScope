import type { FinanceEvent, NetworkEvent, ObservationSet } from '@primusscope/api-schema';
import { buildFinanceAnalytics, buildNetworkAnalytics, type AnalyticsOptions } from './analytics';
import { buildStrategyAnalytics, combinedStrategy, decimalUnits } from './strategy-analytics';

export type ComparisonUnavailableReason = 'NO_FIXED_PERIOD' | 'INCOMPLETE_COVERAGE' | 'MISSING_TIMESTAMPS';
export type ComparisonMetric = {
  key: string;
  label: string;
  unit: string;
  current: string | null;
  previous: string | null;
  delta: string | null;
  percentChange: number | null;
};
export type ComparisonWindow = {
  from: string | null;
  to: string | null;
  coveredFrom: string | null;
  coveredTo: string | null;
  complete: boolean;
};
export type ComparisonGroup = {
  status: 'available' | 'unavailable';
  reason: ComparisonUnavailableReason | null;
  current: ComparisonWindow;
  previous: ComparisonWindow;
  metrics: ComparisonMetric[];
};

const NO_BOUNDS: ComparisonWindow = { from: null, to: null, coveredFrom: null, coveredTo: null, complete: false };
const ms = (value: string | null) => value === null ? null : Date.parse(value);

function fixedPeriod(options: AnalyticsOptions): boolean {
  return options.range !== undefined && options.range !== 'all';
}

function makeWindow(from: string | null, to: string | null, coverageFrom: string | null, coverageTo: string,
  sourceComplete: boolean, hasMissingTimestamps: boolean): ComparisonWindow {
  if (from === null || to === null) return { ...NO_BOUNDS };
  const start = Date.parse(from), end = Date.parse(to);
  const coveredStart = coverageFrom === null ? null : Date.parse(coverageFrom);
  const coveredEnd = Date.parse(coverageTo);
  const intersects = coveredStart !== null && start <= coveredEnd && end >= coveredStart;
  const coveredFrom = intersects ? new Date(Math.max(start, coveredStart!)).toISOString() : null;
  const coveredTo = intersects ? new Date(Math.min(end, coveredEnd)).toISOString() : null;
  return { from, to, coveredFrom, coveredTo,
    complete: sourceComplete && !hasMissingTimestamps && coveredStart !== null && start >= coveredStart && end <= coveredEnd };
}

function windows(from: string | null, to: string | null, coverageFrom: string | null, coverageTo: string,
  sourceComplete: boolean, hasMissingTimestamps: boolean, canCompare: boolean) {
  if (from === null || to === null || !canCompare) return { current: { ...NO_BOUNDS }, previous: { ...NO_BOUNDS } };
  const currentFrom = Date.parse(from), currentTo = Date.parse(to);
  const duration = currentTo - currentFrom + 1;
  const previousTo = currentFrom - 1;
  const previousFrom = previousTo - duration + 1;
  return {
    current: makeWindow(from, to, coverageFrom, coverageTo, sourceComplete, hasMissingTimestamps),
    previous: makeWindow(new Date(previousFrom).toISOString(), new Date(previousTo).toISOString(),
      coverageFrom, coverageTo, sourceComplete, hasMissingTimestamps),
  };
}

function metric(key: string, label: string, unit: string, currentValue: bigint | null,
  previousValue: bigint | null, currentComplete: boolean, previousComplete: boolean,
  format: (value: bigint) => string = String): ComparisonMetric {
  const current = currentComplete && currentValue !== null ? currentValue : null;
  const previous = previousComplete && previousValue !== null ? previousValue : null;
  const delta = current !== null && previous !== null ? current - previous : null;
  let percentChange: number | null = null;
  if (delta !== null && previous !== null && previous !== 0n) {
    const percent = Number(delta) / Number(previous < 0n ? -previous : previous) * 100;
    if (Number.isFinite(percent)) percentChange = percent;
  }
  return { key, label, unit, current: current === null ? null : format(current), previous: previous === null ? null : format(previous),
    delta: delta === null ? null : format(delta), percentChange };
}

function group(current: ComparisonWindow, previous: ComparisonWindow, metrics: ComparisonMetric[],
  fixed: boolean, sourceComplete: boolean, hasMissingTimestamps: boolean): ComparisonGroup {
  const available = fixed && current.complete && previous.complete;
  const reason: ComparisonUnavailableReason | null = !fixed ? 'NO_FIXED_PERIOD'
    : hasMissingTimestamps ? 'MISSING_TIMESTAMPS'
    : !sourceComplete || !current.complete || !previous.complete ? 'INCOMPLETE_COVERAGE' : null;
  return { status: available ? 'available' : 'unavailable', reason, current, previous, metrics };
}

function countEvents(events: Array<FinanceEvent | NetworkEvent>, from: string | null, to: string | null, kind: string): bigint | null {
  if (from === null || to === null) return null;
  const low = Date.parse(from), high = Date.parse(to);
  return BigInt(events.filter(event => event.kind === kind && event.timestamp !== null
    && Date.parse(event.timestamp) >= low && Date.parse(event.timestamp) <= high).length);
}

function sumFlows(strategy: ReturnType<typeof combinedStrategy>, from: string | null, to: string | null, kind: 'Deposit' | 'Withdraw'): bigint | null {
  if (from === null || to === null) return null;
  const low = Date.parse(from), high = Date.parse(to);
  return strategy.flows.filter(flow => flow.kind === kind && Date.parse(flow.timestamp) >= low && Date.parse(flow.timestamp) <= high)
    .reduce((total, flow) => total + BigInt(flow.assetsRaw), 0n);
}

export function buildNetworkComparison(snapshot: ObservationSet, options: AnalyticsOptions = {}) {
  const analytics = buildNetworkAnalytics(snapshot, options);
  const coverage = snapshot.network.coverage;
  const relevant = snapshot.network.events;
  const fixed = fixedPeriod(options);
  const pair = windows(analytics.requestedFrom, analytics.requestedTo, coverage.fromTime, coverage.toTime,
    coverage.completeForRegisteredContracts, relevant.some(event => event.timestamp === null), fixed);
  const kinds = [
    ['SubmitTask', 'Requests'], ['ReportResult', 'Attestor reports'],
    ['WithdrawBalance', 'Withdrawal events'], ['CallbackFailed', 'Callback failures'],
  ] as const;
  const metrics = kinds.map(([kind, label]) => metric(kind, label, 'events',
    countEvents(relevant, pair.current.from, pair.current.to, kind),
    countEvents(relevant, pair.previous.from, pair.previous.to, kind), pair.current.complete, pair.previous.complete));
  return group(pair.current, pair.previous, metrics, fixed, coverage.completeForRegisteredContracts,
    relevant.some(event => event.timestamp === null));
}

export function buildFinanceComparison(snapshot: ObservationSet, options: AnalyticsOptions = {}) {
  const finance = buildFinanceAnalytics(snapshot, options);
  const financeCoverage = snapshot.finance.coverage;
  const contracts = snapshot.finance.contracts.filter(contract => options.routeId === undefined || contract.routeId === options.routeId);
  const addresses = new Set(contracts.map(contract => contract.address.toLowerCase()));
  const routeEvents = snapshot.finance.events.filter(event => addresses.has(event.contractAddress.toLowerCase()));
  const fixed = fixedPeriod(options);
  const routePair = windows(finance.requestedFrom, finance.requestedTo, financeCoverage.fromTime, financeCoverage.toTime,
    financeCoverage.completeForRegisteredContracts, routeEvents.some(event => event.timestamp === null), fixed);
  const routeKinds = [
    ['AggregateDispatched', 'Dispatched aggregates'], ['AggregateFinalized', 'Finalized aggregates'],
    ['AggregateCanceled', 'Canceled aggregates'],
  ] as const;
  const routeMetrics = routeKinds.map(([kind, label]) => metric(kind, label, 'events',
    countEvents(routeEvents, routePair.current.from, routePair.current.to, kind),
    countEvents(routeEvents, routePair.previous.from, routePair.previous.to, kind),
    routePair.current.complete, routePair.previous.complete));
  const routeOperations = group(routePair.current, routePair.previous, routeMetrics, fixed,
    financeCoverage.completeForRegisteredContracts, routeEvents.some(event => event.timestamp === null));

  const strategyAnalytics = buildStrategyAnalytics(snapshot, options);
  const strategy = combinedStrategy(snapshot);
  const flowCoverage = strategy.flowCoverage;
  const strategyHasMissing = strategy.flows.some(flow => flow.timestamp === null);
  const flowPair = windows(strategyAnalytics.requestedFrom, strategyAnalytics.requestedTo,
    flowCoverage?.fromTime ?? null, flowCoverage?.toTime ?? strategyAnalytics.requestedTo,
    flowCoverage?.complete ?? false, strategyHasMissing, fixed);
  const deposits = (from: string | null, to: string | null) => sumFlows(strategy, from, to, 'Deposit');
  const withdrawals = (from: string | null, to: string | null) => sumFlows(strategy, from, to, 'Withdraw');
  const currentDeposits = deposits(flowPair.current.from, flowPair.current.to);
  const previousDeposits = deposits(flowPair.previous.from, flowPair.previous.to);
  const currentWithdrawals = withdrawals(flowPair.current.from, flowPair.current.to);
  const previousWithdrawals = withdrawals(flowPair.previous.from, flowPair.previous.to);
  const flowMetrics = [
    metric('deposits', 'Deposits', 'USDu', currentDeposits, previousDeposits,
      flowPair.current.complete, flowPair.previous.complete, value => decimalUnits(String(value))),
    metric('withdrawals', 'Withdrawals', 'USDu', currentWithdrawals, previousWithdrawals,
      flowPair.current.complete, flowPair.previous.complete, value => decimalUnits(String(value))),
    metric('netFlows', 'Net flow', 'USDu', currentDeposits === null || currentWithdrawals === null ? null : currentDeposits - currentWithdrawals,
      previousDeposits === null || previousWithdrawals === null ? null : previousDeposits - previousWithdrawals,
      flowPair.current.complete, flowPair.previous.complete, value => decimalUnits(String(value))),
  ];
  const strategyFlows = group(flowPair.current, flowPair.previous, flowMetrics, fixed,
    flowCoverage?.complete ?? false, strategyHasMissing);
  return { routeOperations, strategyFlows };
}
