import { createHash } from 'node:crypto';
import { decodeEventLog, getEventSelector, type Abi, type Hex } from 'viem';
import type { FinanceEvent, NetworkEvent, ObservationSet } from '@primusscope/api-schema';

export type Domain = 'finance' | 'network';
export const EVIDENCE_POLICY = 'event_history_with_target_pinned_compatibility_v1';
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const UPGRADED_TOPIC = getEventSelector('Upgraded(address)');
export const NETWORK_ABI = [
  {type:'event',name:'SubmitTask',inputs:[{name:'submitter',type:'address',indexed:true},{name:'taskId',type:'bytes32',indexed:false},{name:'templateId',type:'string',indexed:false},{name:'attestors',type:'address[]',indexed:false},{name:'submittedAt',type:'uint64',indexed:false}]},
  {type:'event',name:'ReportResult',inputs:[{name:'attestor',type:'address',indexed:true},{name:'taskId',type:'bytes32',indexed:false},{name:'user',type:'address',indexed:false},{name:'tokenSymbol',type:'uint8',indexed:false},{name:'primusFee',type:'uint256',indexed:false},{name:'attestorFee',type:'uint256',indexed:false}]},
  {type:'event',name:'WithdrawBalance',inputs:[{name:'user',type:'address',indexed:true},{name:'tokenSymbol',type:'uint8',indexed:false},{name:'amount',type:'uint256',indexed:false},{name:'settledTaskIds',type:'bytes32[]',indexed:false},{name:'taskStatuses',type:'uint8[]',indexed:false}]},
  {type:'event',name:'CallbackFailed',inputs:[{name:'taskId',type:'bytes32',indexed:false},{name:'callback',type:'address',indexed:false},{name:'reason',type:'string',indexed:false}]},
] as const;
export const FINANCE_ABI = [
  {type:'event',name:'AggregateDispatched',inputs:[{name:'batchId',type:'uint256',indexed:true}]},
  {type:'event',name:'AggregateFinalized',inputs:[{name:'batchId',type:'uint256',indexed:true},{name:'amount',type:'uint64',indexed:false}]},
  {type:'event',name:'AggregateCanceled',inputs:[{name:'batchId',type:'uint256',indexed:true}]},
  {type:'event',name:'StepAdvanced',inputs:[{name:'batchId',type:'uint256',indexed:true},{name:'step',type:'uint8',indexed:false}]},
  {type:'event',name:'Recovered',inputs:[{name:'batchId',type:'uint256',indexed:true},{name:'recovered',type:'bool',indexed:false}]},
] as const;
export type ContractPin = {address:string; implementation:string; proxyCodeSha256:string; implementationCodeSha256:string};
export type Source = {domain:Domain; chainId:56|8453; endpoint:string; sourceId:string; seedBlock:string;seedHash:Hex; contracts:ContractPin[]; abi:Abi; topics:Hex[]; compatibility:string};
const financeRuntime = 'c85d18dc1e49769e01f9f88981176e213b2bc24d2f14d33a81d54bc06579f6db';
export function sourceFor(domain:Domain,snapshot:ObservationSet):Source {
  if(domain==='finance') return {
    domain,chainId:56,endpoint:'https://bsc-rpc.publicnode.com',sourceId:'bsc-publicnode',seedBlock:'132545501',seedHash:'0x6f33cf34fc0040f994fa1ceb3b01e76e2071125ec0dd11ff147cb7731278e1c5',abi:FINANCE_ABI,
    contracts:snapshot.finance.contracts.map(contract=>({address:contract.address.toLowerCase(),implementation:contract.implementationAddress.toLowerCase(),proxyCodeSha256:financeRuntime,
      implementationCodeSha256:contract.role==='deposit'?'34910bb1d076c0b04e15bf75d272dab6f37130a00b6079a22110f8149cd99d63':'ee04306623a925f0862ed0cc9b3b9dd47deed75e059a2b78efd89a6ae1ff0269'})),
    topics:[...FINANCE_ABI.map(event=>getEventSelector(event)),UPGRADED_TOPIC],compatibility:EVIDENCE_POLICY+': explorer-matched event shapes; finalized-target bytecode/implementation pins and standard upgrade-event checks; historical ABI intervals not independently established',
  };
  return {domain,chainId:8453,endpoint:'https://base-rpc.publicnode.com',sourceId:'base-publicnode',seedBlock:'55091641',seedHash:'0xfb1357279e587c74888541bc7e1e1a4a38cd2145db62703d4dc7836033942a2c',abi:NETWORK_ABI,
    contracts:[{address:snapshot.network.taskContract.toLowerCase(),implementation:'0xfda482dd37609f11fd0e8c415cccfd4f070a1845',proxyCodeSha256:'3c47cfab74f55b1215a36870e1b51c940713076e1dcf25418035034d383ea566',implementationCodeSha256:'055eaa2a0bb43243a722062801c97fdf594fac2e647e513411da1df2af681395'}],
    topics:[...NETWORK_ABI.map(event=>getEventSelector(event)),UPGRADED_TOPIC],compatibility:EVIDENCE_POLICY+': official SDK event shapes; finalized-target implementation/code pins and standard upgrade-event checks; independent source match not established; historical ABI intervals not independently established'};
}
export function registeredEndpoint(domain:Domain,snapshot:ObservationSet,override?:string):string {
  const endpoint=sourceFor(domain,snapshot).endpoint;
  // Provider identity is part of each event's provenance. A different host or
  // path needs a reviewed source record, not an unlabelled environment override.
  if(override!==undefined&&override!==endpoint)throw new WorkerError('UNREGISTERED_RPC_SOURCE');
  return endpoint;
}

export class WorkerError extends Error {
  constructor(public readonly code:string,public readonly splitRange=false,public readonly retryAfterSeconds?:number){super(code);this.name='WorkerError';}
}
export function hexQuantity(value:unknown):bigint {
  if(typeof value!=='string'||!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)||value.length>66)throw new WorkerError('INVALID_CHAIN_DATA');
  return BigInt(value);
}
export function bytes(value:unknown,maxBytes=2_000_000):Hex {
  if(typeof value!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)||(value.length-2)/2>maxBytes)throw new WorkerError('INVALID_CHAIN_DATA');
  return value.toLowerCase() as Hex;
}
export function hash(value:unknown):Hex {const result=bytes(value,32);if(result.length!==66)throw new WorkerError('INVALID_CHAIN_DATA');return result;}
export function codeHash(value:unknown):string {const code=bytes(value);if(code==='0x')throw new WorkerError('NO_CONTRACT_CODE');return createHash('sha256').update(Buffer.from(code.slice(2),'hex')).digest('hex');}
export type Header={number:bigint;hash:Hex;parentHash:Hex;time:string};
export function header(value:unknown,expected?:bigint):Header {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkerError('INVALID_BLOCK_HEADER');
  const raw=value as Record<string,unknown>;const number=hexQuantity(raw.number);const timestamp=hexQuantity(raw.timestamp);
  if((expected!==undefined&&number!==expected)||timestamp>8_640_000_000_000n)throw new WorkerError('INVALID_BLOCK_HEADER');
  return {number,hash:hash(raw.hash),parentHash:hash(raw.parentHash),time:new Date(Number(timestamp)*1000).toISOString()};
}
export type SafeEvent=FinanceEvent|NetworkEvent;
export type ParsedLog={event:SafeEvent; raw:Record<string,unknown>};
export function projectLog(value:unknown,source:Source,from:bigint,to:bigint):ParsedLog {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkerError('INVALID_LOG');
  const raw=value as Record<string,unknown>;const address=typeof raw.address==='string'?raw.address.toLowerCase():'';
  if(!source.contracts.some(contract=>contract.address===address)||raw.removed!==false)throw new WorkerError('INVALID_LOG');
  if(!Array.isArray(raw.topics)||raw.topics.length<1||raw.topics.length>4)throw new WorkerError('INVALID_LOG');
  const topics=raw.topics.map(hash) as [Hex,...Hex[]];const data=bytes(raw.data,128_000);
  const blockNumber=hexQuantity(raw.blockNumber);const logIndex=hexQuantity(raw.logIndex);
  if(blockNumber<from||blockNumber>to)throw new WorkerError('LOG_OUTSIDE_RANGE');
  const blockHash=hash(raw.blockHash),transactionHash=hash(raw.transactionHash);
  if(topics[0]===UPGRADED_TOPIC)throw new WorkerError('IMPLEMENTATION_UPGRADE_IN_RANGE');
  if(!source.topics.includes(topics[0]))throw new WorkerError('UNKNOWN_EVENT');
  let decoded;
  try{decoded=decodeEventLog({abi:source.abi,data,topics,strict:true});}catch{throw new WorkerError('EVENT_DECODE_FAILED');}
  const args=(decoded.args??{}) as unknown as Record<string,unknown>;
  const eventName=decoded.eventName;
  if(typeof eventName!=='string')throw new WorkerError('EVENT_DECODE_FAILED');
  const shared={id:[source.chainId,address,transactionHash,logIndex].join(':'),contractAddress:address,blockNumber:String(blockNumber),blockHash,transactionHash,logIndex:String(logIndex),timestamp:null,sourceId:source.sourceId};
  if(source.domain==='finance'){
    const staticWords=decoded.eventName==='AggregateDispatched'||decoded.eventName==='AggregateCanceled'?0:1;
    if(topics.length!==2||data.length!==2+64*staticWords||typeof args.batchId!=='bigint')throw new WorkerError('EVENT_DECODE_FAILED');
    if(staticWords){
      const word=BigInt(data);
      if((eventName==='AggregateFinalized'&&word>=2n**64n)||(eventName==='StepAdvanced'&&word>255n)||(eventName==='Recovered'&&word>1n))throw new WorkerError('EVENT_DECODE_FAILED');
    }
    return {event:{...shared,kind:eventName as FinanceEvent['kind'],batchId:String(args.batchId)},raw};
  }
  if(topics.length!==(decoded.eventName==='CallbackFailed'?1:2))throw new WorkerError('EVENT_DECODE_FAILED');
  const taskId=decoded.eventName==='WithdrawBalance'?null:hash(args.taskId);
  return {event:{...shared,kind:eventName as NetworkEvent['kind'],taskId},raw};
}
