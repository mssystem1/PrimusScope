import {createHash} from 'node:crypto';
import type{ObservationSet}from'@primusscope/api-schema';
import {createRepository,combinedStrategy,DataAccessError,type ServingMode}from'@primusscope/data';
import{watchReference}from'./watch-reference';
import{WatchObservationSchema,type WatchObservation}from'./workspace-schema';
import{parseNetworkPageQuery}from'./network-query';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function observeSavedObjects(snapshot:ObservationSet,items:{id:string;href:string}[],mode:ServingMode){
 const repository=createRepository(snapshot,()=>new Date(),{mode,indexerStatus:null}),strategy=combinedStrategy(snapshot);
 return items.map(item=>{
  const ref=watchReference(item.href),domain=ref?.domain??'network';
  const result:WatchObservation={...item,kind:ref?.kind??'view',domain,availability:'unavailable',reason:'UNSUPPORTED_VIEW',scopeKey:null,contentHash:null,eventCount:null,state:null,stateSampleBlock:null,sourceAsOf:null,coverage:null};
  if(!ref)return result;
  const coverage=snapshot[domain].coverage;
  result.coverage={fromBlock:coverage.fromBlock,toBlock:coverage.toBlock,complete:coverage.completeForRegisteredContracts};result.sourceAsOf=coverage.toTime;
  const registry=domain==='finance'?snapshot.finance.contracts.map(c=>({address:c.address.toLowerCase(),abi:c.abiSha256,implementation:c.implementationAddress.toLowerCase()})).sort((a,b)=>a.address.localeCompare(b.address)):[snapshot.network.taskContract.toLowerCase()];
  result.scopeKey=hash({mode,ref,registry,fromBlock:coverage.fromBlock});
  try{
   let ids:string[]=[];
   if(ref.kind==='task'){
    const task=repository.getNetworkTask(8453,ref.contract,ref.task);ids=task.events.map(e=>e.id);result.eventCount=ids.length;
    result.state=task.nativeState?.name??null;result.stateSampleBlock=task.nativeState?.asOfBlock??null;
   }else if(ref.kind==='batch'){
    const batch=repository.getFinanceBatch(ref.contract,ref.batch);ids=batch.events.map(e=>e.id);result.eventCount=ids.length;
    result.state=batch.nativeState?'Native sample: '+batch.nativeState.name:'Last event: '+batch.observedState;result.stateSampleBlock=batch.nativeState?.asOfBlock??null;
   }else if(ref.kind==='vault'){
    repository.getFinanceVault(ref.routeId);const addresses=new Set(snapshot.finance.contracts.filter(c=>c.routeId===ref.routeId).map(c=>c.address.toLowerCase()));
    ids=snapshot.finance.events.filter(e=>addresses.has(e.contractAddress.toLowerCase())).map(e=>e.id);result.eventCount=ids.length;
   }else{
    const viewQuery=new URLSearchParams(ref.query);if(ref.domain==='finance'&&viewQuery.has('routeId'))repository.getFinanceVault(viewQuery.get('routeId')!);
    if(ref.domain==='network'){const values=Object.fromEntries(viewQuery),{range,interval,from,to,limit,cursor,...filters}=parseNetworkPageQuery(values);repository.getNetworkEvents({...filters,limit:1});}
    // Saved views retain their filters, but this signal describes source updates,
    // never an unqualified change in the view's selected metric/window.
    result.contentHash=hash({toBlock:coverage.toBlock,sourceAsOf:coverage.toTime,...domain==='finance'?{strategyAsOf:strategy.samples.at(-1)?.timestamp??null,flowTo:strategy.flowCoverage?.toBlock??null}:{}});
   }
   result.contentHash??=hash({ids:ids.sort(),state:result.state});result.availability=coverage.completeForRegisteredContracts?'available':'unavailable';result.reason=coverage.completeForRegisteredContracts?null:'INCOMPLETE_COVERAGE';
  }catch(error){if(!(error instanceof DataAccessError))throw error;result.reason='NOT_FOUND';}
  return WatchObservationSchema.parse(result);
 });
}
