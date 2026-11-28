import {createHash} from 'node:crypto';
import { FinanceStrategySchema, type FinanceStrategy, type ObservationSet } from '@primusscope/api-schema';
import retained from '../../../data/strategy/unitas-history.json';
import type { AnalyticsOptions } from './analytics';
import { analyticsWindow } from './analytics-selection';

const BASE=FinanceStrategySchema.parse(retained);
const RETAINED_HISTORY_ID=createHash('sha256').update(JSON.stringify(BASE)).digest('hex');
export function decimalUnits(raw:string,decimals=18){
  const negative=raw.startsWith('-'),value=BigInt(negative?raw.slice(1):raw),scale=10n**BigInt(decimals);
  const whole=String(value/scale),fraction=String(value%scale).padStart(decimals,'0').replace(/0+$/,'');
  return (negative&&value!==0n?'-':'')+whole+(fraction?'.'+fraction:'');
}
const MS_DAY=86400000;
export const MAX_STOCK_SAMPLE_GAP_MS=36*3600000;
export function strategyApy(samples:FinanceStrategy['samples'],index:number,days:number,anchors:FinanceStrategy['samples']=[]):number|null{
  const current=samples[index]!,now=Date.parse(current.timestamp),target=now-days*MS_DAY;
  let nearest:FinanceStrategy['samples'][number]|undefined,difference=Infinity;
  for(const candidate of [...samples.slice(0,index),...anchors]){
    if(Date.parse(candidate.timestamp)>=now||BigInt(candidate.exchangeRateRaw)===0n)continue;
    const delta=Math.abs(Date.parse(candidate.timestamp)-target);
    if(delta<difference){difference=delta;nearest=candidate;}
  }
  if(!nearest||difference>2*3600000||BigInt(nearest.exchangeRateRaw)===0n)return null;
  const elapsed=(now-Date.parse(nearest.timestamp))/1000;
  const result=(Math.pow(Number(current.exchangeRateRaw)/Number(nearest.exchangeRateRaw),365*86400/elapsed)-1)*100;
  return Number.isFinite(result)?result:null;
}
export function mergeStrategyFlowHistory(base:FinanceStrategy,incoming:FinanceStrategy){
  const flows=new Map<string,FinanceStrategy['flows'][number]>();
  for(const flow of [...base.flows,...incoming.flows]){
    const key=flow.transactionHash.toLowerCase()+':'+flow.logIndex,prior=flows.get(key);
    if(prior&&['blockNumber','blockHash','timestamp','kind','assetsRaw','sharesRaw'].some(field=>prior[field as keyof typeof prior]!==flow[field as keyof typeof flow]))throw new Error('STRATEGY_FLOW_CONFLICT');
    if(!prior)flows.set(key,flow);
  }
  let flowCoverage=incoming.flowCoverage??base.flowCoverage;
  const a=base.flowCoverage,b=incoming.flowCoverage;
  if(a?.complete&&b?.complete){
    if(BigInt(a.toBlock)+1n<BigInt(b.fromBlock)||BigInt(b.toBlock)+1n<BigInt(a.fromBlock))throw new Error('STRATEGY_FLOW_COVERAGE_GAP');
    const first=BigInt(a.fromBlock)<=BigInt(b.fromBlock)?a:b,last=BigInt(a.toBlock)>=BigInt(b.toBlock)?a:b;
    flowCoverage={...last,fromBlock:first.fromBlock,fromTime:first.fromTime,
      sourceUrls:[...new Set([...(a.sourceUrls??[a.sourceUrl]),...(b.sourceUrls??[b.sourceUrl])])],
      observedAt:Date.parse(a.observedAt)>=Date.parse(b.observedAt)?a.observedAt:b.observedAt};
  }
  return {flows:[...flows.values()].sort((a,b)=>BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:BigInt(a.blockNumber)>BigInt(b.blockNumber)?1:BigInt(a.logIndex)<BigInt(b.logIndex)?-1:BigInt(a.logIndex)>BigInt(b.logIndex)?1:0),flowCoverage};
}
export function combinedStrategy(snapshot:ObservationSet):FinanceStrategy{
  const live=snapshot.finance.strategy;
  if(!live)return BASE;
  const samples=new Map(BASE.samples.map(sample=>[sample.blockNumber,sample]));
  for(const sample of live.samples)samples.set(sample.blockNumber,sample);
  return FinanceStrategySchema.parse({...BASE,...live,samples:[...samples.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)),
    ...(BASE.apyAnchors||live.apyAnchors?{apyAnchors:[...new Map([...(BASE.apyAnchors??[]),...(live.apyAnchors??[])].map(s=>[s.blockNumber,s])).values()]}:{}),
    ...mergeStrategyFlowHistory(BASE,live)});
}

export function buildStrategyAnalytics(snapshot:ObservationSet,options:AnalyticsOptions={}){
  const strategy=combinedStrategy(snapshot),samples=strategy.samples;
  const availableLatest=samples.at(-1);
  const {routeId:_route,...selection}=options;
  const window=analyticsWindow(Date.parse(samples[0]?.timestamp??new Date().toISOString()),
    Date.parse(availableLatest?.timestamp??new Date().toISOString()),{range:'30d',...selection});
  const {start:from,end}=window;
  const latest=samples.filter(sample=>Date.parse(sample.timestamp)>=from&&Date.parse(sample.timestamp)<=end).at(-1);
  const latestIndex=latest?samples.indexOf(latest):-1;
  const points=samples.map((sample,index)=>({label:sample.timestamp,blockNumber:sample.blockNumber,blockHash:sample.blockHash,
    assets:decimalUnits(sample.totalAssetsRaw),shares:decimalUnits(sample.totalSupplyRaw),nav:decimalUnits(sample.exchangeRateRaw),
    apy7d:strategyApy(samples,index,7,strategy.apyAnchors),apy30d:strategyApy(samples,index,30,strategy.apyAnchors)})).filter(point=>Date.parse(point.label)>=from&&Date.parse(point.label)<=end);
  const sampleGaps=samples.slice(1).flatMap((sample,index)=>{const previous=samples[index]!,a=Date.parse(previous.timestamp),b=Date.parse(sample.timestamp);return b-a>MAX_STOCK_SAMPLE_GAP_MS&&a<=end&&b>=from?[{from:previous.timestamp,to:sample.timestamp}]:[];});
  const step=window.step,buckets=new Map<number,{deposits:bigint;withdrawals:bigint}>();
  const coverage=strategy.flowCoverage;
  const flowSelection=coverage?analyticsWindow(Date.parse(coverage.fromTime),Date.parse(coverage.toTime),{range:'30d',...selection},coverage.complete,{from:Date.parse(window.requestedFrom),to:Date.parse(window.requestedTo)}):null;
  if(coverage?.complete&&flowSelection?.hasCoverage){
    const start=flowSelection.start,stop=flowSelection.end;
    for(let time=Math.floor(start/step)*step;time<=stop;time+=step)buckets.set(time,{deposits:0n,withdrawals:0n});
    for(const flow of strategy.flows){
      const time=Date.parse(flow.timestamp);if(time<start||time>stop)continue;
      const bucket=buckets.get(Math.floor(time/step)*step);if(!bucket)continue;
      if(flow.kind==='Deposit')bucket.deposits+=BigInt(flow.assetsRaw);else bucket.withdrawals+=BigInt(flow.assetsRaw);
    }
  }
  const flows=[...buckets].map(([at,values])=>({label:new Date(at).toISOString(),deposits:decimalUnits(String(values.deposits)),
    withdrawals:decimalUnits(String(values.withdrawals)),netFlows:decimalUnits(String(values.deposits-values.withdrawals))}));
  return {retainedHistoryId:RETAINED_HISTORY_ID,attribution:'shared_unitas_strategy' as const,assetSymbol:'USDu' as const,shareSymbol:'sUSDu' as const,
    sourceUrl:latest?.sourceUrl??'https://bsc-mainnet.public.blastapi.io',vaultAddress:strategy.vaultAddress,proxyAddress:strategy.proxyAddress,
    sourceAsOf:latest?.timestamp??null,observedAt:latest?.observedAt??null,
    latest:latest?{assets:decimalUnits(latest.totalAssetsRaw),shares:decimalUnits(latest.totalSupplyRaw),nav:decimalUnits(latest.exchangeRateRaw),
      apy7d:strategyApy(samples,latestIndex,7,strategy.apyAnchors),apy30d:strategyApy(samples,latestIndex,30,strategy.apyAnchors)}:null,
    points,flows,flowCoverage:coverage,from:window.from,to:window.to,
    requestedFrom:window.requestedFrom,requestedTo:window.requestedTo,coveredFrom:window.coveredFrom,coveredTo:window.coveredTo,
    hasCoverage:window.hasCoverage,historyComplete:window.historyComplete,sampleHistoryComplete:window.historyComplete&&sampleGaps.length===0,sampleGaps,
    availableAsOf:availableLatest?.timestamp??null,flowHistoryComplete:flowSelection?.historyComplete??false,
    flowSelection:flowSelection?{from:flowSelection.from,to:flowSelection.to,hasCoverage:flowSelection.hasCoverage,historyComplete:flowSelection.historyComplete,bucketCoverage:flowSelection.bucketCoverage}:null,
    definition:{assets:'StakedUSDu.totalAssets(): USDu backing shares, excluding unvested rewards; not Primus-only TVL.',
      shares:'StakedUSDu.totalSupply(); these sUSDu shares are distinct from eU/eUSDT.',
      apy:'100 × ((NAV_now / NAV_anchor)^(365 × 86400 / actual_elapsed_seconds) − 1). Anchor is within two hours of 7D/30D target.',
      flows:'Public shared StakedUSDu ERC-4626 Deposit/Withdraw asset amounts. Net flow = deposits − withdrawals. No Primus attribution.'}};
}
