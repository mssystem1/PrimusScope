import { describe,expect,it } from 'vitest';
import { FinanceStrategySchema, ObservationSetSchema } from '@primusscope/api-schema';
import source from '../../../data/strategy/unitas-history.json';
import recorded from '../../../data/observations/current.json';
import {buildStrategyAnalytics,decimalUnits} from './strategy-analytics';

const snapshot=ObservationSetSchema.parse(recorded),strategy=FinanceStrategySchema.parse(source);
describe('public shared-strategy financial analytics',()=>{
  it('preserves raw token precision, signed net flows and token units',()=>{
    expect(decimalUnits('123456789012345678901')).toBe('123.456789012345678901');
    expect(decimalUnits('-1000000000000000001')).toBe('-1.000000000000000001');
    const data=buildStrategyAnalytics(snapshot,{range:'30d'});
    expect(data.retainedHistoryId).toMatch(/^[a-f0-9]{64}$/);expect(data.attribution).toBe('shared_unitas_strategy');expect(data.assetSymbol).toBe('USDu');
    expect(data.latest?.shares).toBe(decimalUnits(strategy.samples.at(-1)!.totalSupplyRaw));
    expect(data.latest?.apy7d).not.toBeNull();expect(data.latest?.apy30d).not.toBeNull();
    expect(data.points.length).toBeGreaterThanOrEqual(30);
  });
  it('derives 7D/30D APY from geometric NAV growth over actual elapsed seconds',()=>{
    const input=structuredClone(snapshot),origin=Date.parse('2027-01-01T00:00:00Z');
    input.finance.strategy={...strategy,flows:[],flowCoverage:null,samples:Array.from({length:61},(_,i)=>({
      ...strategy.samples[0]!,blockNumber:String(200000000+i),timestamp:new Date(origin+i*86400000).toISOString(),
      exchangeRateRaw:String(BigInt(Math.round(1e18*Math.pow(1.1,i/365))))}))};
    const result=buildStrategyAnalytics(input,{range:'24h'});
    expect(result.latest?.apy7d).toBeCloseTo(10,8);expect(result.latest?.apy30d).toBeCloseTo(10,8);
    const all=buildStrategyAnalytics(input,{range:'all'});
    expect(all.points.find(p=>p.label==='2027-01-01T00:00:00.000Z')?.apy30d).toBeNull();
  });
  it('reconciles deposited/withdrawn/net assets without filling uncovered history',()=>{
    const result=buildStrategyAnalytics(snapshot,{range:'30d',interval:'day'}),coverage=strategy.flowCoverage!;
    expect(result.flows.length).toBeGreaterThan(0);expect(Date.parse(result.flows[0]!.label)).toBeGreaterThanOrEqual(Date.parse(coverage.fromTime)-86400000);
    const sum=(key:'deposits'|'withdrawals'|'netFlows')=>result.flows.reduce((n,row)=>n+Number(row[key]),0);
    expect(sum('netFlows')).toBeCloseTo(sum('deposits')-sum('withdrawals'),6);
    expect(result.flows.length).toBeGreaterThanOrEqual(29);expect(result.flows.length).toBeLessThanOrEqual(32);
    const input=structuredClone(snapshot);input.finance.strategy={...strategy,flowCoverage:{...coverage,complete:false}};
    expect(buildStrategyAnalytics(input,{range:'30d'}).flows).toEqual([]);
  });
  it('rejects participant/private fields from the public strategy schema',()=>{
    const invalid=structuredClone(strategy);Object.assign(invalid.flows[0]!,{owner:'0x'+'11'.repeat(20)});
    expect(()=>FinanceStrategySchema.parse(invalid)).toThrow();
  });
});

describe('historical flow extension beside a live publication',()=>{
  it('preserves full backfilled coverage when a narrower live publication is present',async()=>{
    const {mergeStrategyFlowHistory}=await import('./strategy-analytics');
    const historical=structuredClone(strategy),live=structuredClone(strategy);
    historical.flowCoverage={...historical.flowCoverage!,fromBlock:historical.samples[0]!.blockNumber,fromTime:historical.samples[0]!.timestamp,sourceUrl:'https://bsc.api.pocket.network'};
    const result=mergeStrategyFlowHistory(historical,live);
    expect(result.flowCoverage?.fromBlock).toBe(historical.samples[0]!.blockNumber);
    expect(result.flowCoverage?.sourceUrls).toContain('https://bsc.api.pocket.network');
    expect(result.flows).toHaveLength(strategy.flows.length);
  });
  it('deduplicates semantic log identity across importer/runtime ID formats and refuses conflicting amounts',async()=>{
    const {mergeStrategyFlowHistory}=await import('./strategy-analytics');const live=structuredClone(strategy);
    live.flows[0]!.id='56:another-format:'+live.flows[0]!.transactionHash+':'+live.flows[0]!.logIndex;
    expect(mergeStrategyFlowHistory(strategy,live).flows).toHaveLength(strategy.flows.length);
    live.flows[0]!.assetsRaw=String(BigInt(live.flows[0]!.assetsRaw)+1n);
    expect(()=>mergeStrategyFlowHistory(strategy,live)).toThrow('STRATEGY_FLOW_CONFLICT');
  });
  it('refuses to claim continuous coverage across disjoint scans',async()=>{
    const {mergeStrategyFlowHistory}=await import('./strategy-analytics');const live=structuredClone(strategy);
    live.flowCoverage={...live.flowCoverage!,fromBlock:String(BigInt(strategy.flowCoverage!.toBlock)+2n),toBlock:String(BigInt(strategy.flowCoverage!.toBlock)+3n)};
    expect(()=>mergeStrategyFlowHistory(strategy,live)).toThrow('STRATEGY_FLOW_COVERAGE_GAP');
  });
});


describe('complete retained-period public flow history',()=>{
  it('covers every stock interval and reconciles exact minted/burned shares for all 60 days',()=>{
    expect(strategy.flowCoverage?.complete).toBe(true);
    expect(BigInt(strategy.flowCoverage!.fromBlock)).toBeLessThanOrEqual(BigInt(strategy.samples[0]!.blockNumber));
    expect(BigInt(strategy.flowCoverage!.toBlock)).toBeGreaterThanOrEqual(BigInt(strategy.samples.at(-1)!.blockNumber));
    expect(new Set(strategy.flows.map(flow=>flow.transactionHash+':'+flow.logIndex)).size).toBe(strategy.flows.length);
    let intervals=0;
    for(let i=1;i<strategy.samples.length;i++){
      const before=strategy.samples[i-1]!,after=strategy.samples[i]!;
      const delta=strategy.flows.filter(flow=>BigInt(flow.blockNumber)>BigInt(before.blockNumber)&&BigInt(flow.blockNumber)<=BigInt(after.blockNumber))
        .reduce((sum,flow)=>sum+(flow.kind==='Deposit'?BigInt(flow.sharesRaw):-BigInt(flow.sharesRaw)),0n);
      expect(delta).toBe(BigInt(after.totalSupplyRaw)-BigInt(before.totalSupplyRaw));intervals++;
    }
    expect(intervals).toBe(60);
    const data=buildStrategyAnalytics(snapshot,{range:'all'});
    expect(data.flowHistoryComplete).toBe(true);expect(data.flows.length).toBeGreaterThanOrEqual(60);
  });
});
