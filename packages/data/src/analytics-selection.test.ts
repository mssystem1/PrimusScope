import { describe, expect, it } from 'vitest';
import { AnalyticsSelectionSchema, FinanceStrategySchema } from '@primusscope/api-schema';
import { analyticsWindow } from './analytics-selection';
import { getObservationSet } from './serving';
import { buildFinanceAnalytics, buildNetworkAnalytics } from './analytics';
import { buildStrategyAnalytics } from './strategy-analytics';
import retainedStrategy from '../../../data/strategy/unitas-history.json';
const source=await getObservationSet();
describe('exact UTC analytical selections',()=>{
  it('requires real paired dates, ordered and bounded to366 days, only for custom periods',()=>{
    for(const value of [{range:'custom'},{range:'custom',from:'2026-02-30',to:'2026-03-01'},{range:'custom',from:'2026-11-10',to:'2026-11-09'},{range:'custom',from:'2025-01-01',to:'2026-01-02'},{range:'30d',from:'2026-11-01',to:'2026-11-09'}])expect(AnalyticsSelectionSchema.safeParse(value).success).toBe(false);
    expect(AnalyticsSelectionSchema.safeParse({range:'custom',from:'2024-02-29',to:'2024-02-29'}).success).toBe(true);
  });
  it('exposes exact partial UTC bucket boundaries and source completeness',()=>{
    const start=Date.parse('2026-11-09T06:45:04Z'),end=Date.parse('2026-11-09T07:18:23Z');
    const result=analyticsWindow(start,end,{range:'custom',interval:'hour',from:'2026-11-09',to:'2026-11-09'});
    expect(result.requestedTo).toBe('2026-11-09T23:59:59.999Z');
    expect(result.historyComplete).toBe(false);expect(result.hasCoverage).toBe(true);
    expect(result.bucketCoverage).toEqual([{at:'2026-11-09T06:00:00.000Z',from:'2026-11-09T06:45:04.000Z',to:'2026-11-09T06:59:59.999Z',partial:true},{at:'2026-11-09T07:00:00.000Z',from:'2026-11-09T07:00:00.000Z',to:'2026-11-09T07:18:23.000Z',partial:true}]);
    expect(analyticsWindow(start,end,{range:'all'},false).historyComplete).toBe(false);
  });
  it('includes only the chosen calendar days and leaves uncovered ranges empty',()=>{
    const options={range:'custom' as const,from:'2026-11-09',to:'2026-11-09'};
    const finance=buildFinanceAnalytics(source,options),network=buildNetworkAnalytics(source,options);
    expect(finance.series.reduce((sum,row)=>sum+Number(row.AggregateDispatched),0)).toBe(source.finance.events.filter(e=>e.kind==='AggregateDispatched').length);
    expect(network.requestCohort.requestCount).toBe(116);
    const empty=buildNetworkAnalytics(source,{range:'custom',from:'2026-10-01',to:'2026-10-02'});
    expect(empty).toMatchObject({hasCoverage:false,historyComplete:false,coveredFrom:null,coveredTo:null,series:[]});
    expect(empty.requestCohort.reportObservedRate).toBeNull();
    const incomplete=structuredClone(source);incomplete.finance.coverage.completeForRegisteredContracts=false;
    expect(buildFinanceAnalytics(incomplete,{range:'all'}).historyComplete).toBe(false);
  });
  it('selects historical stock KPIs and uses pre-window NAV anchors with measured historical flows',()=>{
    const data=buildStrategyAnalytics(source,{range:'custom',from:'2026-10-01',to:'2026-10-15'});
    expect(data.points).toHaveLength(15);expect(data.sourceAsOf?.slice(0,10)).toBe('2026-10-15');
    expect(data.latest?.nav).toBe(data.points.at(-1)?.nav);expect(data.latest?.apy7d).not.toBeNull();
    expect(data.latest?.apy30d).not.toBeNull();expect(data.flows).toHaveLength(15);
    expect(data.flowHistoryComplete).toBe(true);expect(data.flowSelection?.hasCoverage).toBe(true);
    const future=buildStrategyAnalytics(source,{range:'custom',from:'2027-01-01',to:'2027-01-02'});
    expect(future).toMatchObject({latest:null,points:[],flows:[],hasCoverage:false});
  });
  it('marks a lagging flow head as partial relative to the chosen stock period',()=>{
    const input=structuredClone(source),history=FinanceStrategySchema.parse(retainedStrategy),last=history.samples.at(-1)!;
    history.samples.push({...last,blockNumber:String(BigInt(last.blockNumber)+10000n),timestamp:new Date(Date.parse(last.timestamp)+7200000).toISOString()});
    input.finance.strategy=history;
    const result=buildStrategyAnalytics(input,{range:'30d'});
    expect(result.flowHistoryComplete).toBe(false);
    expect(Date.parse(result.flowSelection!.to)).toBeLessThan(Date.parse(result.requestedTo));
  });
  it('scopes financial flow completeness separately from daily samples and retains exact first/last boundaries',()=>{
    const data=buildStrategyAnalytics(source,{range:'30d',interval:'day'});
    expect(data.sampleHistoryComplete).toBe(true);expect(data.flowHistoryComplete).toBe(true);
    const incomplete=structuredClone(source);
    // An explicitly incomplete live flow scan must not inherit sample completeness.
    const first=data.flowSelection!.bucketCoverage[0]!;
    expect(first.partial).toBe(true);expect(first.from).toBe(data.flowSelection!.from);
    expect(data.flowSelection!.bucketCoverage.at(-1)!.to).toBe(data.flowSelection!.to);
    incomplete.finance.strategy=FinanceStrategySchema.parse({...retainedStrategy,flowCoverage:{...retainedStrategy.flowCoverage!,complete:false}});
    const partial=buildStrategyAnalytics(incomplete,{range:'30d'});
    expect(partial.sampleHistoryComplete).toBe(true);expect(partial.flowHistoryComplete).toBe(false);expect(partial.flows).toEqual([]);
  });
});
