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
    expect(data.attribution).toBe('shared_unitas_strategy');expect(data.assetSymbol).toBe('USDu');
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
    expect(result.flows.length).toBeLessThan(15);
    const input=structuredClone(snapshot);input.finance.strategy={...strategy,flowCoverage:{...coverage,complete:false}};
    expect(buildStrategyAnalytics(input,{range:'30d'}).flows).toEqual([]);
  });
  it('rejects participant/private fields from the public strategy schema',()=>{
    const invalid=structuredClone(strategy);Object.assign(invalid.flows[0]!,{owner:'0x'+'11'.repeat(20)});
    expect(()=>FinanceStrategySchema.parse(invalid)).toThrow();
  });
});
