import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { SQLiteStore } from '@primusscope/storage';
import { ObservationSetSchema, type ObservationSet } from '@primusscope/api-schema';
import recorded from '../../../data/observations/current.json';
import { DEFAULT_SCAN_LIMITS, runOnce, seedAnchors } from './indexer';
import { FINANCE_ABI, IMPLEMENTATION_SLOT, UPGRADED_TOPIC, WorkerError, codeHash, sourceFor, type Source } from './registry';
import type { Rpc } from './rpc';

const directories:string[]=[];afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const h=(value:number)=>'0x'+value.toString(16).padStart(64,'0');
const q=(value:number)=>'0x'+value.toString(16);
const time=(value:number)=>new Date(Date.parse('2026-11-09T00:00:00Z')+value*1000).toISOString();
function seed():ObservationSet {
  const value=structuredClone(recorded);value.finance.events=[];value.finance.stateSamples=[];value.finance.latencySamples=[];
  value.finance.coverage.fromBlock='1';value.finance.coverage.toBlock='10';value.finance.coverage.fromTime=time(1);value.finance.coverage.toTime=time(10);
  return ObservationSetSchema.parse(value);
}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'primusscope-worker-test-'));directories.push(directory);const path=join(directory,'index.sqlite');
  const store=new SQLiteStore(path);const snapshot=seed();store.initialize(snapshot,{finance:h(10),network:h(100)});
  return {path,store,snapshot};
}
function sourceFactory(domain:'finance'|'network',snapshot:ObservationSet):Source {
  const source=sourceFor(domain,snapshot);return {...source,contracts:source.contracts.map(pin=>({...pin,proxyCodeSha256:codeHash('0x60'),implementationCodeSha256:codeHash('0x60')}))};
}
function log(source:Source,block=12){
  return {address:source.contracts[0]!.address,topics:encodeEventTopics({abi:FINANCE_ABI,eventName:'AggregateDispatched',args:{batchId:7n}}),
    data:'0x',blockNumber:q(block),blockHash:h(block),transactionHash:h(1000+block),logIndex:'0x0',removed:false};
}
class FakeRpc implements Rpc {
  requestsMade=0;calls:{method:string;params:unknown[]}[]=[];logs:Record<string,unknown>[]=[];finalized=13;wrongChain=false;anchorChanged=false;badImpl=false;badReceipt=false;failLogs:string|null=null;splitAbove:number|null=null;failFromBlock:number|null=null;archiveCodeRefused=false;changeImplAfterLogs=false;changeTargetAfterLogs=false;targetChanged=false;
  constructor(readonly source:Source){}
  async call(method:string,params:unknown[]):Promise<unknown>{
    this.requestsMade++;this.calls.push({method,params});
    if(method==='eth_chainId')return this.wrongChain?'0x1':'0x38';
    if(method==='eth_getCode'){
      if(this.archiveCodeRefused&&BigInt(String(params[1]))<BigInt(this.finalized))throw new WorkerError('RPC_ARCHIVE_UNAVAILABLE');
      return '0x60';
    }
    if(method==='eth_getStorageAt'){
      expect(params[1]).toBe(IMPLEMENTATION_SLOT);
      const pin=this.source.contracts.find(pin=>pin.address===params[0])!;
      return '0x'+'0'.repeat(24)+(this.badImpl?'1'.repeat(40):pin.implementation.slice(2));
    }
    if(method==='eth_getBlockByNumber'){
      const block=params[0]==='finalized'?this.finalized:Number(BigInt(String(params[0])));
      return {number:q(block),hash:(this.anchorChanged&&block===10)||(this.targetChanged&&block===this.finalized)?h(999):h(block),parentHash:h(block-1),timestamp:q(1794182400+block)};
    }
    if(method==='eth_getLogs'){
      const query=params[0]as {fromBlock:string;toBlock:string;topics:string[][]};
      expect(query.topics[0]).toContain(UPGRADED_TOPIC);
      if(this.changeImplAfterLogs)this.badImpl=true;if(this.changeTargetAfterLogs)this.targetChanged=true;
      if(this.failFromBlock&&BigInt(query.fromBlock)>=BigInt(this.failFromBlock))throw new WorkerError('REQUEST_BUDGET_EXHAUSTED');
      if(this.failLogs)throw new WorkerError(this.failLogs,false,this.failLogs==='RATE_LIMITED'?30:undefined);
      if(this.splitAbove&&Number(BigInt(query.toBlock)-BigInt(query.fromBlock)+1n)>this.splitAbove)throw new WorkerError('RPC_RANGE_LIMIT',true);
      return this.logs.filter(log=>BigInt(String(log.blockNumber))>=BigInt(query.fromBlock)&&BigInt(String(log.blockNumber))<=BigInt(query.toBlock));
    }
    if(method==='eth_getTransactionReceipt'){
      const log=this.logs.find(log=>log.transactionHash===params[0])!;
      return {transactionHash:log.transactionHash,blockHash:this.badReceipt?h(555):log.blockHash,blockNumber:log.blockNumber,status:'0x1',logs:[log]};
    }
    throw new Error('Unexpected fake method');
  }
}
const limits={...DEFAULT_SCAN_LIMITS,maxBlocks:3,chunkSize:2};

describe('incremental worker with durable SQLite commits',()=>{
  it('rejects a changed retained seed hash even when its timestamp is unchanged',async()=>{
    const snapshot=ObservationSetSchema.parse(recorded);
    const rpc:Rpc={requestsMade:0,call:async(method:string)=>{
      if(method==='eth_chainId')return '0x38';
      if(method==='eth_getBlockByNumber')return {number:'0x'+BigInt(snapshot.finance.coverage.toBlock).toString(16),hash:h(999),parentHash:h(998),timestamp:'0x'+BigInt(Date.parse(snapshot.finance.coverage.toTime)/1000).toString(16)};
      throw new Error('Seed hash must fail before code reads');
    }};
    await expect(seedAnchors(snapshot,()=>rpc)).rejects.toThrow('SEED_HASH_CHANGED');
  });
  it('commits a sanitized event, reopens the file, resumes exactly once, and advances an empty scope',async()=>{
    const {path,store,snapshot}=fixture();const source=sourceFactory('finance',snapshot);const rpc=new FakeRpc(source);rpc.logs=[log(source)];
    const first=await runOnce(store,rpc,'finance',limits,sourceFactory);
    expect(first).toMatchObject({outcome:'advanced',eventsAdded:1,committedRanges:2,toBlock:'13',remainingBlocks:'0'});
    const event=store.readSnapshot().finance.events[0]!;expect(event.kind).toBe('AggregateDispatched');expect(event.timestamp).toBe(time(12));
    expect(Object.keys(event).sort()).toEqual(['batchId','blockHash','blockNumber','contractAddress','id','kind','logIndex','sourceId','timestamp','transactionHash']);
    store.close();
    const reopened=new SQLiteStore(path);const resumed=new FakeRpc(source);resumed.finalized=15;
    const second=await runOnce(reopened,resumed,'finance',limits,sourceFactory);
    expect(second).toMatchObject({outcome:'advanced',eventsAdded:0,toBlock:'15'});
    expect(reopened.readSnapshot().finance.events).toHaveLength(1);expect(reopened.getCheckpoint('finance').nextBlock).toBe('16');
    expect((resumed.calls.find(call=>call.method==='eth_getLogs')!.params[0]as {fromBlock:string}).fromBlock).toBe('0xe');
    reopened.close();
  });
  it('wrong-chain data never advances the checkpoint',async()=>{
    const {store,snapshot}=fixture();const rpc=new FakeRpc(sourceFactory('finance',snapshot));rpc.wrongChain=true;
    expect(await runOnce(store,rpc,'finance',limits,sourceFactory)).toMatchObject({outcome:'failed',code:'WRONG_CHAIN',committedRanges:0});
    expect(store.getCheckpoint('finance').toBlock).toBe('10');expect(store.getCheckpoint('finance').quarantined).toBe(false);store.close();
  });
  it('failed ranges retain publication and do not fabricate empty coverage',async()=>{
    const {store,snapshot}=fixture();const rpc=new FakeRpc(sourceFactory('finance',snapshot));rpc.failLogs='REQUEST_BUDGET_EXHAUSTED';
    const before=store.readSnapshot().snapshotId;
    expect(await runOnce(store,rpc,'finance',limits,sourceFactory)).toMatchObject({outcome:'failed',code:'REQUEST_BUDGET_EXHAUSTED'});
    expect(store.readSnapshot().snapshotId).toBe(before);expect(store.getCheckpoint('finance').toBlock).toBe('10');store.close();
  });
  it('retains completed chunks when a later chunk fails',async()=>{
    const {store,snapshot}=fixture();const source=sourceFactory('finance',snapshot);const rpc=new FakeRpc(source);rpc.logs=[log(source)];rpc.failFromBlock=13;
    const report=await runOnce(store,rpc,'finance',limits,sourceFactory);
    expect(report).toMatchObject({outcome:'failed',code:'REQUEST_BUDGET_EXHAUSTED',committedRanges:1,eventsAdded:1,fromBlock:'11',toBlock:'12',remainingBlocks:'1'});
    expect(store.getCheckpoint('finance').toBlock).toBe('12');expect(store.readSnapshot().finance.events).toHaveLength(1);store.close();
  });
  it('persists numeric Retry-After and makes no RPC request during cooldown',async()=>{
    const {store,snapshot}=fixture();const source=sourceFactory('finance',snapshot);const rpc=new FakeRpc(source);rpc.failLogs='RATE_LIMITED';
    expect(await runOnce(store,rpc,'finance',limits,sourceFactory)).toMatchObject({code:'RATE_LIMITED',retryAfterSeconds:30});
    const second=new FakeRpc(source);
    expect(await runOnce(store,second,'finance',limits,sourceFactory)).toMatchObject({code:'COOLDOWN_ACTIVE',rpcRequests:0});
    expect(store.getCheckpoint('finance').toBlock).toBe('10');expect(store.getCheckpoint('finance').nextRetryAt).not.toBeNull();store.close();
  });
  it('shrinks provider range-limit failures and commits contiguous empty ranges',async()=>{
    const {store,snapshot}=fixture();const rpc=new FakeRpc(sourceFactory('finance',snapshot));rpc.splitAbove=1;
    const result=await runOnce(store,rpc,'finance',limits,sourceFactory);
    expect(result).toMatchObject({outcome:'advanced',committedRanges:3,toBlock:'13',eventsAdded:0});store.close();
  });
  it.each(['anchor','implementation','upgrade','malformed','receipt']as const)('quarantines %s inconsistency without advancing',async failure=>{
    const {store,snapshot}=fixture();const source=sourceFactory('finance',snapshot);const rpc=new FakeRpc(source);const raw=log(source);
    if(failure==='anchor')rpc.anchorChanged=true;
    if(failure==='implementation')rpc.badImpl=true;
    if(failure==='upgrade'){raw.topics=[UPGRADED_TOPIC];rpc.logs=[raw];}
    if(failure==='malformed'){raw.data='0x00';rpc.logs=[raw];}
    if(failure==='receipt'){rpc.logs=[raw];rpc.badReceipt=true;}
    const result=await runOnce(store,rpc,'finance',limits,sourceFactory);
    expect(result.outcome).toBe('failed');expect(store.getCheckpoint('finance').toBlock).toBe('10');expect(store.getCheckpoint('finance').quarantined).toBe(true);
    expect(()=>store.readSnapshot()).toThrow();store.close();
  });
  it('a concurrent lease makes no provider request',async()=>{
    const {store,snapshot}=fixture();const lease=store.acquireLease('finance','other-worker',60_000)!;const rpc=new FakeRpc(sourceFactory('finance',snapshot));
    expect(await runOnce(store,rpc,'finance',limits,sourceFactory)).toMatchObject({outcome:'busy',code:'LEASE_BUSY',rpcRequests:0});
    store.releaseLease(lease.token);store.close();
  });
  it('uses explicit target-pinned policy when historical code is unavailable',async()=>{
    const {store,snapshot}=fixture();const rpc=new FakeRpc(sourceFactory('finance',snapshot));rpc.archiveCodeRefused=true;
    const result=await runOnce(store,rpc,'finance',limits,sourceFactory);
    expect(result).toMatchObject({outcome:'advanced',toBlock:'13',evidencePolicy:'event_history_with_target_pinned_compatibility_v1'});
    for(const call of rpc.calls.filter(call=>call.method==='eth_getCode'))expect(call.params[1]).toBe('0xd');store.close();
  });
  it.each(['implementation','target_hash']as const)('rechecks the same finalized target before publishing: %s',async failure=>{
    const {store,snapshot}=fixture();const rpc=new FakeRpc(sourceFactory('finance',snapshot));
    if(failure==='implementation')rpc.changeImplAfterLogs=true;else rpc.changeTargetAfterLogs=true;
    const result=await runOnce(store,rpc,'finance',limits,sourceFactory);
    expect(result.outcome).toBe('failed');expect(store.getCheckpoint('finance').toBlock).toBe('10');expect(store.getCheckpoint('finance').quarantined).toBe(true);store.close();
  });
});
