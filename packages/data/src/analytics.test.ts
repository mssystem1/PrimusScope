import { describe, expect, it } from 'vitest';
import { getObservationSet } from './serving';
import { buildFinanceAnalytics, buildNetworkAnalytics } from './analytics';

const source = await getObservationSet();

describe('source-traceable analytics', () => {
  it('counts requests with zero reports in the denominator without treating map membership as a response',()=>{
    const result=buildNetworkAnalytics(source);
    expect(result.requestCohort.requestsWithSubsequentReport).toBe(result.firstReportLatency.count);
    expect(result.requestCohort.requestsWithSubsequentReport).toBeLessThan(result.requestCohort.requestCount);
    expect(result.requestCohort.requestsWithSubsequentReport).toBeLessThanOrEqual(source.network.events.filter(e=>e.kind==='ReportResult').length);
  });
  it('reports the retained finance history window and missing timestamps without inventing earlier rows', () => {
    const incomplete=structuredClone(source);
    incomplete.finance.events.forEach((event,index)=>{if(index>=2)event.timestamp=null;});
    const result = buildFinanceAnalytics(incomplete);
    expect(result.from).toBe(source.finance.coverage.fromTime);
    expect(result.to).toBe(source.finance.coverage.toTime);
    expect(result.historyComplete).toBe(true);
    expect(result.missingTimestampCount).toBe(7);
    expect(result.series.reduce((n, row) => n + Number(row.AggregateDispatched), 0)).toBe(incomplete.finance.events.filter(e=>e.kind==='AggregateDispatched'&&e.timestamp!==null).length);
  });

  it('clamps requested windows to source coverage and preserves empty time buckets', () => {
    const result = buildFinanceAnalytics(source, { range: '30d', interval: 'hour' });
    expect(result.from).toBe(source.finance.coverage.fromTime);
    expect(result.historyComplete).toBe(false);
    expect(result.series.length).toBeGreaterThan(1);
    expect(result.series.every(row => row.at.endsWith(':00:00.000Z'))).toBe(true);
  });

  it('uses route scope for deposit and redeem activity', () => {
    const all = buildFinanceAnalytics(source);
    const selected = buildFinanceAnalytics(source, { routeId: 'united-stables-confidential-vault' });
    expect(selected.routeActivity).toHaveLength(1);
    expect(selected.routeActivity[0]!.routeId).toContain('united-stables');
    expect(selected.routeActivity[0]!.depositEventCount + selected.routeActivity[0]!.redeemEventCount)
      .toBeLessThanOrEqual(all.routeActivity.reduce((n, r) => n + r.depositEventCount + r.redeemEventCount, 0));
    expect(selected.lifecycleScope).toBe('full_covered_history');
  });

  it('measures only timestamped dispatch-to-finalization pairs and leaves empty quantiles null', () => {
    const copy = structuredClone(source);
    const pair = copy.finance.events.filter(e => e.batchId === '146');
    pair.find(e => e.kind === 'AggregateDispatched')!.timestamp = '2026-11-09T07:00:00.000Z';
    pair.find(e => e.kind === 'AggregateFinalized')!.timestamp = '2026-11-09T07:00:55.000Z';
    const measured = buildFinanceAnalytics(copy);
    expect(measured.dispatchToFinalized).toMatchObject({ count: 1, p50Seconds: 55, p90Seconds: 55 });
    const noTimes = structuredClone(source);
    noTimes.finance.events.forEach(e => { e.timestamp = null; });
    const empty = buildFinanceAnalytics(noTimes).dispatchToFinalized;
    expect(empty.p50Seconds).toBeNull();
  });

  it('does not infer network outcomes from missing timestamps or reports without a request', () => {
    const incomplete=structuredClone(source);incomplete.network.events.forEach(event=>{event.timestamp=null;});
    const result = buildNetworkAnalytics(incomplete);
    expect(result.missingTimestampCount).toBe(223);
    expect(result.series).toEqual([]);
    expect(result.requestCohort).toMatchObject({ requestCount: 0, requestsWithSubsequentReport: 0, reportObservedRate: null });
    expect(result.firstReportLatency.p50Seconds).toBeNull();
  });

  it('measures observed request cohorts, first-report latency and per-request report counts', () => {
    const copy = structuredClone(source);
    copy.network.coverage.fromTime='2026-11-09T05:00:00.000Z';
    copy.network.events.forEach(event=>{event.timestamp=null;});
    const events = copy.network.events;
    const reportTasks = new Set(events.filter(e => e.kind === 'ReportResult').map(e => e.taskId));
    const task = events.find(e => e.kind === 'SubmitTask' && reportTasks.has(e.taskId))!.taskId!;
    const request = events.find(e => e.kind === 'SubmitTask' && e.taskId === task)!;
    request.timestamp = '2026-11-09T06:00:00.000Z';
    const reports = events.filter(e => e.kind === 'ReportResult' && e.taskId === task);
    const requestCopy = structuredClone(request);
    requestCopy.id += '-duplicate'; requestCopy.blockNumber = '200';
    requestCopy.timestamp = '2026-11-09T06:03:00.000Z'; events.push(requestCopy);
    request.blockNumber = '100'; request.logIndex = '0';
    request.timestamp = '2026-11-09T06:00:00.000Z';
    for (const report of reports) report.timestamp = null;
    reports[0]!.blockNumber = '99';
    reports[0]!.timestamp = '2026-11-09T06:00:00.000Z';
    const eligible = structuredClone(reports[0]!);
    eligible.id += '-eligible'; eligible.blockNumber = '100'; eligible.logIndex = '1';
    eligible.timestamp = '2026-11-09T06:00:00.000Z'; events.push(eligible);
    const result = buildNetworkAnalytics(copy);
    expect(result.requestCohort).toMatchObject({ requestCount: 1, requestsWithSubsequentReport: 1, reportObservedRate: 1 });
    expect(result.firstReportLatency).toMatchObject({ count: 1, p50Seconds: 0 });
    expect(result.reportCountDistribution).toContainEqual({ reportCount: 1, requestCount: 1 });
    expect(result.utcHourActivity).toContainEqual({ hour: '2026-11-09T06:00:00.000Z', eventCount: 4 });
  });
});
