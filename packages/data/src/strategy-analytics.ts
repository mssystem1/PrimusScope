import { FinanceStrategySchema, type FinanceStrategy, type ObservationSet } from '@primusscope/api-schema';
import retained from '../../../data/strategy/unitas-history.json';
import type { AnalyticsOptions } from './analytics';

const BASE=FinanceStrategySchema.parse(retained);
export function decimalUnits(raw:string,decimals=18){
  const negative=raw.startsWith('-'),value=BigInt(negative?raw.slice(1):raw),scale=10n**BigInt(decimals);
  const whole=String(value/scale),fraction=String(value%scale).padStart(decimals,'0').replace(/0+$/,'');
  return (negative&&value!==0n?'-':'')+whole+(fraction?'.'+fraction:'');
}
const MS_DAY=86400000;
function apy(samples:FinanceStrategy['samples'],index:number,days:number):number|null{
  const current=samples[index]!,now=Date.parse(current.timestamp),target=now-days*MS_DAY;
  let nearest:FinanceStrategy['samples'][number]|undefined,difference=Infinity;
  for(let i=0;i<index;i++){
    const candidate=samples[i]!,delta=Math.abs(Date.parse(candidate.timestamp)-target);
    if(delta<difference){difference=delta;nearest=candidate;}
  }
  if(!nearest||difference>2*3600000||BigInt(nearest.exchangeRateRaw)===0n)return null;
  const elapsed=(now-Date.parse(nearest.timestamp))/1000;
  const result=(Math.pow(Number(current.exchangeRateRaw)/Number(nearest.exchangeRateRaw),365*86400/elapsed)-1)*100;
  return Number.isFinite(result)?result:null;
}
export function combinedStrategy(snapshot:ObservationSet):FinanceStrategy{
  const live=snapshot.finance.strategy;
  if(!live)return BASE;
  const samples=new Map(BASE.samples.map(sample=>[sample.blockNumber,sample]));
  for(const sample of live.samples)samples.set(sample.blockNumber,sample);
  const flows=new Map(BASE.flows.map(flow=>[flow.id,flow]));for(const flow of live.flows)flows.set(flow.id,flow);
  return FinanceStrategySchema.parse({...BASE,...live,samples:[...samples.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)),
    flows:[...flows.values()].sort((a,b)=>BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:BigInt(a.blockNumber)>BigInt(b.blockNumber)?1:BigInt(a.logIndex)<BigInt(b.logIndex)?-1:1),
    flowCoverage:live.flowCoverage??BASE.flowCoverage});
}
export function buildStrategyAnalytics(snapshot:ObservationSet,options:AnalyticsOptions={}){
  const strategy=combinedStrategy(snapshot),samples=strategy.samples;
  const latest=samples.at(-1);
  const end=latest?Date.parse(latest.timestamp):Date.now(),days=options.range==='24h'?1:options.range==='7d'?7:options.range==='all'?Infinity:30;
  const from=days===Infinity?Date.parse(samples[0]?.timestamp??new Date(end).toISOString()):end-days*MS_DAY;
  const points=samples.map((sample,index)=>({label:sample.timestamp,blockNumber:sample.blockNumber,blockHash:sample.blockHash,
    assets:decimalUnits(sample.totalAssetsRaw),shares:decimalUnits(sample.totalSupplyRaw),nav:decimalUnits(sample.exchangeRateRaw),
    apy7d:apy(samples,index,7),apy30d:apy(samples,index,30)})).filter(point=>Date.parse(point.label)>=from&&Date.parse(point.label)<=end);
  const step=options.interval==='hour'?3600000:MS_DAY,buckets=new Map<number,{deposits:bigint;withdrawals:bigint}>();
  const coverage=strategy.flowCoverage;
  if(coverage?.complete){
    const start=Math.max(from,Date.parse(coverage.fromTime)),stop=Math.min(end,Date.parse(coverage.toTime));
    for(let time=Math.floor(start/step)*step;time<=stop;time+=step)buckets.set(time,{deposits:0n,withdrawals:0n});
    for(const flow of strategy.flows){
      const time=Date.parse(flow.timestamp);if(time<start||time>stop)continue;
      const bucket=buckets.get(Math.floor(time/step)*step);if(!bucket)continue;
      if(flow.kind==='Deposit')bucket.deposits+=BigInt(flow.assetsRaw);else bucket.withdrawals+=BigInt(flow.assetsRaw);
    }
  }
  const flows=[...buckets].map(([at,values])=>({label:new Date(at).toISOString(),deposits:decimalUnits(String(values.deposits)),
    withdrawals:decimalUnits(String(values.withdrawals)),netFlows:decimalUnits(String(values.deposits-values.withdrawals))}));
  return {attribution:'shared_unitas_strategy' as const,assetSymbol:'USDu' as const,shareSymbol:'sUSDu' as const,
    sourceUrl:latest?.sourceUrl??'https://bsc-mainnet.public.blastapi.io',vaultAddress:strategy.vaultAddress,proxyAddress:strategy.proxyAddress,
    sourceAsOf:latest?.timestamp??null,observedAt:latest?.observedAt??null,
    latest:latest?{assets:decimalUnits(latest.totalAssetsRaw),shares:decimalUnits(latest.totalSupplyRaw),nav:decimalUnits(latest.exchangeRateRaw),
      apy7d:apy(samples,samples.length-1,7),apy30d:apy(samples,samples.length-1,30)}:null,
    points,flows,flowCoverage:coverage,from:new Date(from).toISOString(),to:new Date(end).toISOString(),
    historyComplete:samples.length>0&&Date.parse(samples[0]!.timestamp)<=from,
    definition:{assets:'StakedUSDu.totalAssets(): USDu backing shares, excluding unvested rewards; not Primus-only TVL.',
      shares:'StakedUSDu.totalSupply(); these sUSDu shares are distinct from eU/eUSDT.',
      apy:'100 × ((NAV_now / NAV_anchor)^(365 × 86400 / actual_elapsed_seconds) − 1). Anchor is within two hours of 7D/30D target.',
      flows:'Public shared StakedUSDu ERC-4626 Deposit/Withdraw asset amounts. Net flow = deposits − withdrawals. No Primus attribution.'}};
}
