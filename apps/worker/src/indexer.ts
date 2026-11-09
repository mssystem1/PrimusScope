import { randomUUID } from 'node:crypto';
import type { ObservationSet } from '@primusscope/api-schema';
import { StorageError, type Checkpoint, type CompletedRange, type Domain, type Lease, type RunRecord } from '@primusscope/storage';
import { EVIDENCE_POLICY, IMPLEMENTATION_SLOT, WorkerError, bytes, codeHash, hash, header, hexQuantity, projectLog, sourceFor, type Header, type ParsedLog, type Source } from './registry';
import type { Rpc } from './rpc';

export interface Store {
  readSnapshot():ObservationSet;
  getCheckpoint(domain:Domain):Checkpoint;
  acquireLease(domain:Domain,owner:string,ttlMs?:number):Lease|null;
  renewLease(token:string,ttlMs?:number):Lease;
  releaseLease(token:string):void;
  commitRange(domain:Domain,token:string,range:CompletedRange):unknown;
  quarantine(domain:Domain,token:string,code:string):void;
  recordRun(domain:Domain,token:string,run:RunRecord):void;
}
export type ScanLimits={maxBlocks:number;chunkSize:number;maxEventsPerChunk:number;leaseMs:number};
export const DEFAULT_SCAN_LIMITS:ScanLimits={maxBlocks:1000,chunkSize:500,maxEventsPerChunk:250,leaseMs:600_000};
export type RunReport={domain:Domain;chainId:number;evidencePolicy:string;outcome:'idle'|'advanced'|'failed'|'busy';code:string|null;fromBlock:string|null;toBlock:string|null;targetFinalizedBlock:string|null;remainingBlocks:string|null;committedRanges:number;eventsAdded:number;rpcRequests:number;retryAfterSeconds:number|null;completedAt:string;compatibility:string};
const quantity=(value:bigint)=>'0x'+value.toString(16);
const now=()=>new Date().toISOString();
const QUARANTINE=new Set(['CHECKPOINT_HASH_CHANGED','CHECKPOINT_TIME_CHANGED','IMPLEMENTATION_CHANGED','RUNTIME_CODE_CHANGED','IMPLEMENTATION_CODE_CHANGED','IMPLEMENTATION_UPGRADE_IN_RANGE','EVENT_DECODE_FAILED','UNKNOWN_EVENT','INVALID_LOG','LOG_OUTSIDE_RANGE','CONFLICTING_EVENT','RECEIPT_MISMATCH','BLOCK_HASH_MISMATCH','APPEND_PARENT_MISMATCH']);

function compare(a:string,b:string){return BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;}
async function getHeader(rpc:Rpc,block:bigint):Promise<Header>{return header(await rpc.call('eth_getBlockByNumber',[quantity(block),false]),block);}

async function verifyPins(rpc:Rpc,source:Source,block:bigint):Promise<void>{
  const checkedImplementation=new Set<string>();
  for(const pin of source.contracts){
    const proxy=await rpc.call('eth_getCode',[pin.address,quantity(block)]);
    if(codeHash(proxy)!==pin.proxyCodeSha256)throw new WorkerError('RUNTIME_CODE_CHANGED');
    const slot=bytes(await rpc.call('eth_getStorageAt',[pin.address,IMPLEMENTATION_SLOT,quantity(block)]),32);
    if(slot.length!==66||!/^0x0{24}/.test(slot)||'0x'+slot.slice(26)!==pin.implementation)throw new WorkerError('IMPLEMENTATION_CHANGED');
    if(checkedImplementation.has(pin.implementation))continue;
    if(codeHash(await rpc.call('eth_getCode',[pin.implementation,quantity(block)]))!==pin.implementationCodeSha256)throw new WorkerError('IMPLEMENTATION_CODE_CHANGED');
    checkedImplementation.add(pin.implementation);
  }
}

function distinctLogs(raw:unknown,source:Source,from:bigint,to:bigint,max:number):ParsedLog[]{
  if(!Array.isArray(raw))throw new WorkerError('INVALID_LOG');
  if(raw.length>=max)throw new WorkerError('EVENT_LIMIT',true);
  const parsed=raw.map(value=>projectLog(value,source,from,to));
  const ids=new Map<string,ParsedLog>();const blockHashes=new Map<string,string>();const positions=new Map<string,string>();
  for(const value of parsed){
    const event=value.event;const existing=ids.get(event.id);
    if(existing&&JSON.stringify(existing.event)!==JSON.stringify(event))throw new WorkerError('CONFLICTING_EVENT');
    if(existing)throw new WorkerError('DUPLICATE_LOG');
    if(blockHashes.has(event.blockNumber)&&blockHashes.get(event.blockNumber)!==event.blockHash)throw new WorkerError('CONFLICTING_EVENT');
    const position=event.blockHash+':'+event.logIndex;
    if(positions.has(position)&&positions.get(position)!==event.id)throw new WorkerError('CONFLICTING_EVENT');
    ids.set(event.id,value);blockHashes.set(event.blockNumber,event.blockHash);positions.set(position,event.id);
  }
  return [...ids.values()].sort((a,b)=>compare(a.event.blockNumber,b.event.blockNumber)||compare(a.event.logIndex,b.event.logIndex)||a.event.id.localeCompare(b.event.id));
}

function reconcileReceipt(receipt:unknown,values:ParsedLog[]):void{
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new WorkerError('RECEIPT_MISMATCH');
  const raw=receipt as Record<string,unknown>;const first=values[0]!.event;
  if(hash(raw.transactionHash)!==first.transactionHash||hash(raw.blockHash)!==first.blockHash||String(hexQuantity(raw.blockNumber))!==first.blockNumber||hexQuantity(raw.status)!==1n||!Array.isArray(raw.logs))throw new WorkerError('RECEIPT_MISMATCH');
  for(const value of values){
    const event=value.event;
    const matches=raw.logs.filter((item:unknown)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))return false;
      const log=item as Record<string,unknown>;
      return typeof log.address==='string'&&log.address.toLowerCase()===event.contractAddress&&log.logIndex===value.raw.logIndex;
    });
    if(matches.length!==1)throw new WorkerError('RECEIPT_MISMATCH');
    const log=matches[0] as Record<string,unknown>;
    if(log.removed!==false||hash(log.blockHash)!==event.blockHash||hash(log.transactionHash)!==event.transactionHash
      ||log.blockNumber!==value.raw.blockNumber||bytes(log.data)!==bytes(value.raw.data)
      ||!Array.isArray(log.topics)||JSON.stringify(log.topics.map(hash))!==JSON.stringify((value.raw.topics as unknown[]).map(hash)))throw new WorkerError('RECEIPT_MISMATCH');
  }
}

export async function runOnce(store:Store,rpc:Rpc,domain:Domain,limits:ScanLimits=DEFAULT_SCAN_LIMITS,sourceFactory:(domain:Domain,snapshot:ObservationSet)=>Source=sourceFor):Promise<RunReport>{
  for(const [key,value] of Object.entries(limits))if(!Number.isInteger(value)||value<1)throw new WorkerError('INVALID_LIMITS');
  if(limits.maxBlocks>10_000||limits.chunkSize>10_000||limits.maxEventsPerChunk>1000||limits.leaseMs<30_000||limits.leaseMs>600_000)throw new WorkerError('INVALID_LIMITS');
  const snapshot=store.readSnapshot();const source=sourceFactory(domain,snapshot);
  const report:RunReport={domain,chainId:source.chainId,evidencePolicy:EVIDENCE_POLICY,outcome:'idle',code:null,fromBlock:null,toBlock:null,targetFinalizedBlock:null,remainingBlocks:null,committedRanges:0,eventsAdded:0,rpcRequests:0,retryAfterSeconds:null,completedAt:now(),compatibility:source.compatibility};
  const lease=store.acquireLease(domain,'worker:'+randomUUID(),limits.leaseMs);
  if(!lease)return {...report,outcome:'busy',code:'LEASE_BUSY'};
  let checkpoint=store.getCheckpoint(domain);const initial=checkpoint;let target:Header|undefined;
  try{
    if(checkpoint.quarantined)throw new WorkerError('SOURCE_QUARANTINED');
    if(checkpoint.nextRetryAt&&Date.parse(checkpoint.nextRetryAt)>Date.now()){
      report.code='COOLDOWN_ACTIVE';report.retryAfterSeconds=Math.ceil((Date.parse(checkpoint.nextRetryAt)-Date.now())/1000);report.toBlock=checkpoint.toBlock;return report;
    }
    if(hexQuantity(await rpc.call('eth_chainId',[]))!==BigInt(source.chainId))throw new WorkerError('WRONG_CHAIN');
    target=header(await rpc.call('eth_getBlockByNumber',['finalized',false]));
    report.targetFinalizedBlock=String(target.number);
    if(target.number<BigInt(checkpoint.toBlock))throw new WorkerError('FINALIZED_HEAD_BEHIND_CHECKPOINT');
    const anchor=await getHeader(rpc,BigInt(checkpoint.toBlock));
    if(anchor.hash!==checkpoint.blockHash)throw new WorkerError('CHECKPOINT_HASH_CHANGED');
    if(anchor.time!==checkpoint.toTime)throw new WorkerError('CHECKPOINT_TIME_CHANGED');
    await verifyPins(rpc,source,target.number);
    const end=target.number<BigInt(checkpoint.toBlock)+BigInt(limits.maxBlocks)?target.number:BigInt(checkpoint.toBlock)+BigInt(limits.maxBlocks);
    let chunk=limits.chunkSize;
    while(BigInt(checkpoint.toBlock)<end){
      store.renewLease(lease.token,limits.leaseMs);
      const from=BigInt(checkpoint.nextBlock);const to=from+BigInt(chunk)-1n<end?from+BigInt(chunk)-1n:end;
      let additions:ParsedLog[];
      try{
        additions=distinctLogs(await rpc.call('eth_getLogs',[{fromBlock:quantity(from),toBlock:quantity(to),address:source.contracts.map(pin=>pin.address),topics:[source.topics]}]),source,from,to,limits.maxEventsPerChunk);
      }catch(error){
        if(error instanceof WorkerError&&error.splitRange&&to>from){chunk=Math.max(1,Math.floor(Number(to-from+1n)/2));continue;}
        if(error instanceof WorkerError&&error.code==='EVENT_LIMIT')throw new WorkerError('SINGLE_BLOCK_EVENT_LIMIT');
        throw error;
      }
      const first=await getHeader(rpc,from);const last=to===from?first:await getHeader(rpc,to);
      if(first.parentHash!==checkpoint.blockHash)throw new WorkerError('APPEND_PARENT_MISMATCH');
      const blocks=new Map<string,Header>([[String(from),first],[String(to),last]]);
      for(const {event}of additions)if(!blocks.has(event.blockNumber))blocks.set(event.blockNumber,await getHeader(rpc,BigInt(event.blockNumber)));
      const transactions=new Map<string,ParsedLog[]>();
      for(const addition of additions){
        const block=blocks.get(addition.event.blockNumber)!;
        if(block.hash!==addition.event.blockHash)throw new WorkerError('BLOCK_HASH_MISMATCH');
        addition.event.timestamp=block.time;
        const logs=transactions.get(addition.event.transactionHash)??[];logs.push(addition);transactions.set(addition.event.transactionHash,logs);
      }
      for(const [transaction,values]of transactions)reconcileReceipt(await rpc.call('eth_getTransactionReceipt',[transaction]),values);
      // A changing anchor or chunk boundary invalidates all work in this chunk.
      if((await getHeader(rpc,BigInt(checkpoint.toBlock))).hash!==checkpoint.blockHash||(await getHeader(rpc,to)).hash!==last.hash
        ||(await getHeader(rpc,target.number)).hash!==target.hash)throw new WorkerError('CHECKPOINT_HASH_CHANGED');
      // This policy establishes current-target compatibility plus recognized
      // event/receipt evidence. It does not claim archive-code validation at
      // each event height. Any standard upgrade in the scanned range already
      // quarantined above, and these same target pins must remain unchanged.
      await verifyPins(rpc,source,target.number);
      store.commitRange(domain,lease.token,{fromBlock:String(from),toBlock:String(to),previousBlockHash:checkpoint.blockHash,toBlockHash:last.hash,toTime:last.time,observedAt:now(),events:additions.map(value=>value.event) as CompletedRange['events']});
      report.committedRanges++;report.eventsAdded+=additions.length;report.outcome='advanced';
      checkpoint=store.getCheckpoint(domain);chunk=Math.min(limits.chunkSize,chunk*2);
    }
    report.fromBlock=report.committedRanges?initial.nextBlock:null;report.toBlock=checkpoint.toBlock;
    report.remainingBlocks=String(target.number-BigInt(checkpoint.toBlock));
    store.recordRun(domain,lease.token,{outcome:report.outcome==='advanced'?'advanced':'idle',at:now(),targetFinalizedBlock:String(target.number),sourceAsOf:target.time});
  }catch(error){
    const code=error instanceof WorkerError||error instanceof StorageError?error.code:'INDEXER_FAILED';report.outcome='failed';report.code=code;
    if(error instanceof WorkerError&&error.retryAfterSeconds!==undefined)report.retryAfterSeconds=error.retryAfterSeconds;
    report.fromBlock=report.committedRanges?initial.nextBlock:null;report.toBlock=checkpoint.toBlock;
    report.remainingBlocks=target&&target.number>=BigInt(checkpoint.toBlock)?String(target.number-BigInt(checkpoint.toBlock)):null;
    // A lost lease cannot mutate checkpoint/status. Preserve the original safe
    // failure instead of letting a secondary reporting error hide it.
    try{if(QUARANTINE.has(code))store.quarantine(domain,lease.token,code);}catch{}
    try{store.recordRun(domain,lease.token,{outcome:'failed',at:now(),code,...(report.retryAfterSeconds!==null?{retryAfterSeconds:report.retryAfterSeconds}:{}),...(target?{targetFinalizedBlock:String(target.number),sourceAsOf:target.time}:{})});}catch{}
  }finally{report.rpcRequests=rpc.requestsMade;report.completedAt=now();try{store.releaseLease(lease.token);}catch{}}
  return report;
}

export async function seedAnchors(snapshot:ObservationSet,rpcFor:(domain:Domain)=>Rpc):Promise<{finance:string;network:string}>{
  const anchors={finance:'',network:''};
  for(const domain of ['finance','network']as const){
    const source=sourceFor(domain,snapshot),rpc=rpcFor(domain),coverage=snapshot[domain].coverage;
    if(hexQuantity(await rpc.call('eth_chainId',[]))!==BigInt(source.chainId))throw new WorkerError('WRONG_CHAIN');
    if(coverage.toBlock!==source.seedBlock)throw new WorkerError('SEED_RANGE_MISMATCH');
    const anchor=await getHeader(rpc,BigInt(coverage.toBlock));
    if(anchor.hash!==source.seedHash)throw new WorkerError('SEED_HASH_CHANGED');
    if(anchor.time!==coverage.toTime)throw new WorkerError('SEED_TIME_MISMATCH');
    const target=header(await rpc.call('eth_getBlockByNumber',['finalized',false]));
    if(target.number<anchor.number)throw new WorkerError('FINALIZED_HEAD_BEHIND_CHECKPOINT');
    await verifyPins(rpc,source,target.number);
    if((await getHeader(rpc,target.number)).hash!==target.hash||(await getHeader(rpc,anchor.number)).hash!==anchor.hash)throw new WorkerError('CHECKPOINT_HASH_CHANGED');
    anchors[domain]=anchor.hash;
  }
  return anchors;
}
