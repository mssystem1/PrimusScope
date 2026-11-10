import type { AnalyticsSelection, FinanceEvent, NetworkEvent, ObservationSet } from '@primusscope/api-schema';
import { analyticsWindow } from './analytics-selection';

export type AnalyticsRange = NonNullable<AnalyticsSelection['range']>;
export type AnalyticsInterval = NonNullable<AnalyticsSelection['interval']>;
export type AnalyticsOptions = AnalyticsSelection & { routeId?: string };
type Event = FinanceEvent | NetworkEvent;

const ms = (value: string | null) => value === null ? null : Date.parse(value);
const cmpBig = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
function canonicalOrder(a: Event, b: Event): number {
  return cmpBig(a.blockNumber, b.blockNumber) || cmpBig(a.logIndex, b.logIndex)
    || a.transactionHash.localeCompare(b.transactionHash) || a.id.localeCompare(b.id);
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(p * ordered.length) - 1]!;
}
function timeWindow(events: Event[], coverage: ObservationSet['network']['coverage'], options: AnalyticsOptions) {
  const timed = events.map(e => ms(e.timestamp)).filter((v): v is number => v !== null && Number.isFinite(v));
  const end = Date.parse(coverage.toTime);
  const coveredStart = coverage.fromTime === null ? (timed.length ? Math.min(...timed) : end) : Date.parse(coverage.fromTime);
  const {routeId: _route, ...selection} = options;
  return analyticsWindow(coveredStart, end, selection, coverage.fromTime !== null && coverage.completeForRegisteredContracts);
}
function series(events: Event[], window: ReturnType<typeof timeWindow>, kinds: string[]): Array<{ at: string; [key: string]: string | number }> {
  const buckets = new Map<number, Record<string, number>>();
  const inWindow = events.filter(e => { const t = ms(e.timestamp); return t !== null && t >= window.start && t <= window.end; });
  if (!events.some(e => e.timestamp !== null)) return [];
  if (window.start <= window.end) {
    const first = Math.floor(window.start / window.step) * window.step;
    const last = Math.floor(window.end / window.step) * window.step;
    for (let at = first; at <= last; at += window.step) buckets.set(at, Object.fromEntries(kinds.map(k => [k, 0])));
  }
  for (const event of inWindow) {
    const at = Math.floor(ms(event.timestamp) as number / window.step) * window.step;
    const bucket = buckets.get(at);
    if (bucket && event.kind in bucket) bucket[event.kind] = (bucket[event.kind] ?? 0) + 1;
  }
  return [...buckets.entries()].map(([at, counts]) => ({ at: new Date(at).toISOString(), ...counts }));
}
function cumulative(rows: { at: string; [key: string]: string | number }[], fields: string[]) {
  const totals = Object.fromEntries(fields.map(field => [field, 0]));
  return rows.map(row => {
    for (const field of fields) totals[field] = (totals[field] ?? 0) + Number(row[field] ?? 0);
    return { at: row.at, ...totals };
  });
}
function lifecycle(events: FinanceEvent[]) {
  const batches = new Map<string, FinanceEvent[]>();
  for (const event of events) {
    const key = `${event.contractAddress.toLowerCase()}:${event.batchId}`;
    const group = batches.get(key) ?? []; group.push(event); batches.set(key, group);
  }
  const counts: Record<string, number> = { dispatched: 0, finalized: 0, canceled: 0, other: 0 };
  for (const group of batches.values()) {
    const last = group.sort(canonicalOrder).filter(e => ['AggregateDispatched', 'AggregateFinalized', 'AggregateCanceled'].includes(e.kind)).at(-1);
    if (!last) counts.other++;
    else if (last.kind === 'AggregateDispatched') counts.dispatched++;
    else if (last.kind === 'AggregateFinalized') counts.finalized++;
    else counts.canceled++;
  }
  return counts;
}
function latencyDistribution(values: number[]) {
  const buckets = [
    { range: '0-60s', count: 0 }, { range: '61-300s', count: 0 },
    { range: '301-1800s', count: 0 }, { range: '>1800s', count: 0 },
  ];
  for (const value of values) buckets[value <= 60 ? 0 : value <= 300 ? 1 : value <= 1800 ? 2 : 3]!.count++;
  return { count: values.length, p50Seconds: percentile(values, .5), p90Seconds: percentile(values, .9), buckets };
}

export function buildFinanceAnalytics(snapshot: ObservationSet, options: AnalyticsOptions = {}) {
  const contracts = snapshot.finance.contracts.filter(c => options.routeId === undefined || c.routeId === options.routeId);
  const addresses = new Set(contracts.map(c => c.address.toLowerCase()));
  const events = snapshot.finance.events.filter(e => addresses.has(e.contractAddress.toLowerCase())).sort(canonicalOrder);
  const window = timeWindow(events, snapshot.finance.coverage, options);
  const timed = events.filter(e => e.timestamp !== null && Date.parse(e.timestamp) >= window.start && Date.parse(e.timestamp) <= window.end);
  const rows = series(events, window, ['AggregateDispatched', 'AggregateFinalized', 'AggregateCanceled']);
  const paired = new Map<string, { dispatch: number; finalized?: number }>();
  for (const event of events) {
    const key = `${event.contractAddress.toLowerCase()}:${event.batchId}`;
    const t = ms(event.timestamp);
    if (event.kind === 'AggregateDispatched' && t !== null) paired.set(key, { dispatch: t });
    if (event.kind === 'AggregateFinalized' && t !== null && paired.has(key)) paired.get(key)!.finalized = t;
  }
  const latencies = [...paired.values()].filter(p => p.finalized !== undefined && p.finalized >= p.dispatch
    && p.dispatch >= window.start && p.finalized <= window.end).map(p => (p.finalized! - p.dispatch) / 1000);
  const timedEvents = new Set(timed);
  const routeCounts = contracts.map(contract => ({ routeId: contract.routeId, role: contract.role,
    eventCount: events.filter(e => e.contractAddress.toLowerCase() === contract.address.toLowerCase() && timedEvents.has(e)).length }));
  return {
    domain: 'finance' as const, range: options.range ?? 'all', interval: options.interval ?? 'day',
    from: window.from, to: window.to, requestedFrom: window.requestedFrom, requestedTo: window.requestedTo,
    coveredFrom: window.coveredFrom, coveredTo: window.coveredTo, hasCoverage: window.hasCoverage,
    bucketCoverage: window.bucketCoverage, historyComplete: window.historyComplete, missingTimestampCount: events.filter(e => e.timestamp === null).length,
    series: rows, cumulative: cumulative(rows, ['AggregateDispatched', 'AggregateFinalized']),
    routeActivity: [...new Set(contracts.map(c => c.routeId))].map(routeId => ({ routeId,
      depositEventCount: routeCounts.filter(r => r.routeId === routeId && r.role === 'deposit').reduce((n, r) => n + r.eventCount, 0),
      redeemEventCount: routeCounts.filter(r => r.routeId === routeId && r.role === 'redeem').reduce((n, r) => n + r.eventCount, 0) })),
    lifecycleScope: 'full_covered_history' as const, lifecycle: lifecycle(events), dispatchToFinalized: latencyDistribution(latencies),
  };
}

export function buildNetworkAnalytics(snapshot: ObservationSet, options: AnalyticsOptions = {}) {
  const events = [...snapshot.network.events].sort(canonicalOrder);
  const window = timeWindow(events, snapshot.network.coverage, options);
  const timed = events.filter(e => e.timestamp !== null && Date.parse(e.timestamp) >= window.start && Date.parse(e.timestamp) <= window.end);
  const rows = series(events, window, ['SubmitTask', 'ReportResult', 'WithdrawBalance', 'CallbackFailed']);
  const requests = new Map<string, NetworkEvent>();
  for (const e of events) if (e.kind === 'SubmitTask' && e.taskId && !requests.has(e.taskId)) requests.set(e.taskId, e);
  for (const [task, request] of requests) {
    const at = ms(request.timestamp);
    if (at === null || at < window.start || at > window.end) requests.delete(task);
  }
  const eligibleReports = new Map<string, NetworkEvent[]>();
  for (const e of timed) {
    if (e.kind !== 'ReportResult' || !e.taskId) continue;
    const request = requests.get(e.taskId);
    if (request && canonicalOrder(e, request) >= 0 && (ms(e.timestamp)! - ms(request.timestamp)!) >= 0) {
      const reports = eligibleReports.get(e.taskId) ?? [];
      reports.push(e); eligibleReports.set(e.taskId, reports);
    }
  }
  const firstReportLatencies: number[] = [];
  const reportCounts = new Map<string, number>();
  for (const [task, request] of requests) {
    const reports = eligibleReports.get(task) ?? [];
    reportCounts.set(task, reports.length);
    if (reports.length) {
      const first = reports.reduce((a, b) => canonicalOrder(a, b) <= 0 ? a : b);
      firstReportLatencies.push((ms(first.timestamp)! - ms(request.timestamp)!) / 1000);
    }
  }
  const byReportCount = new Map<number, number>();
  for (const task of requests.keys()) { const count = reportCounts.get(task) ?? 0; byReportCount.set(count, (byReportCount.get(count) ?? 0) + 1); }
  const utcHours = new Map<string, number>();
  for (const e of timed) if (e.timestamp) { const hour = new Date(Date.parse(e.timestamp)).toISOString().slice(0, 13) + ':00:00.000Z'; utcHours.set(hour, (utcHours.get(hour) ?? 0) + 1); }
  const missingRequestCount = [...requests.keys()].filter(task => (reportCounts.get(task) ?? 0) === 0).length;
  const totalRequests = requests.size;
  return {
    domain: 'network' as const, range: options.range ?? 'all', interval: options.interval ?? 'day',
    from: window.from, to: window.to, requestedFrom: window.requestedFrom, requestedTo: window.requestedTo,
    coveredFrom: window.coveredFrom, coveredTo: window.coveredTo, hasCoverage: window.hasCoverage,
    bucketCoverage: window.bucketCoverage, historyComplete: window.historyComplete, missingTimestampCount: events.filter(e => e.timestamp === null).length,
    series: rows, cumulative: cumulative(rows, ['SubmitTask', 'ReportResult']),
    requestCohort: { requestCount: totalRequests, requestsWithSubsequentReport: totalRequests - missingRequestCount,
      reportObservedRate: totalRequests ? (totalRequests - missingRequestCount) / totalRequests : null },
    firstReportLatency: latencyDistribution(firstReportLatencies),
    reportCountDistribution: [...byReportCount.entries()].sort(([a], [b]) => a - b).map(([reportCount, requestCount]) => ({ reportCount, requestCount })),
    utcHourActivity: [...utcHours.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, eventCount]) => ({ hour, eventCount })),
  };
}
