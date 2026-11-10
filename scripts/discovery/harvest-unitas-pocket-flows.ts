import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FinanceStrategySchema } from '../../packages/api-schema/src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = resolve(ROOT, 'data/strategy/unitas-history.json');
const PINS = resolve(ROOT, 'data/strategy/unitas-history-provenance.json');
const CHECKPOINT = resolve(ROOT, '.local/research/pocket-history-checkpoint.json');
const RPC = 'https://bsc.api.pocket.network';
const FREE_HEADER_FALLBACK_RPC='https://bsc-mainnet.public.blastapi.io';
const FREE_NOWNODES_RPC='https://public-bsc.nownodes.io';
const VAULT = '0x385c279445581a186a4182a5503094ebb652ec71';
const DEP = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';
const WDR = '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db';
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LOCKED_REDISTRIBUTED='0xb8ef21f2b52f8ca740012254a6b10f17d2fd6e589f97ebf401fde0e8b9218937';
const CHUNK = 5000n;
const MAX_LOG_CALLS = 2600;
const MAX_OPS = 12000;
const MAX_FLOWS = 20000;
type Flow = { id:string; blockNumber:string; blockHash:string; transactionHash:string; logIndex:string; timestamp:string; kind:'Deposit'|'Withdraw'; assetsRaw:string; sharesRaw:string };
type Header = { number:bigint; hash:string; timestamp:number };
let nextRequestStart=0;
let requestId = 0, ops = 0, calls = 0, receipts = {attempted:0, matchedTransactions:0, mismatchedTransactions:0, unavailableTransactions:0};
let verifiedReceiptTxs:string[]=[];
let receiptSources:Record<string,'Pocket'|'Blast'>={};
let eventMetadata:Record<string,{hash:string;timestamp:string}>={};
let fallbackHeaderReads=0;

const hx=(n:bigint)=>`0x${n.toString(16)}`;
const iso=(t:number)=>new Date(t*1000).toISOString();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function batch(methods:Array<{method:string;params:unknown[]}>,endpoint=RPC):Promise<unknown[]> {
  if(ops+methods.length>MAX_OPS) throw Error('MAX_TOTAL_OPS');
  const payload=methods.map(x=>({jsonrpc:'2.0',id:++requestId,method:x.method,params:x.params}));
  for(let attempt=0;attempt<5;attempt++) {
    if(ops+methods.length>MAX_OPS)throw Error('MAX_TOTAL_OPS');
    const slot=Math.max(Date.now(),nextRequestStart);nextRequestStart=slot+methods.length*200;
    await sleep(Math.max(0,slot-Date.now()));
    ops+=methods.length;
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    if(response.status===429) { const ra=response.headers.get('retry-after'); const wait=ra&&/^\d+$/.test(ra)?Number(ra)*1000:60000; console.log(JSON.stringify({status:'rate_limited',retryAfterMs:wait,ops,calls})); if(attempt===4||wait>300000)throw Error('RATE_LIMIT_PAUSED');await sleep(wait); continue; }
    if([502,503,504].includes(response.status)&&attempt<4){await sleep((attempt+1)*2000);continue;}
    if(!response.ok) throw Error(`HTTP_${response.status}`);
    const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();if(!reader)throw Error('EMPTY_RPC_RESPONSE');
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4_000_000){await reader.cancel();throw Error('RPC_RESPONSE_TOO_LARGE');}chunks.push(part.value);}}finally{reader.releaseLock();}
    const decoded=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Array<Record<string,unknown>>|Record<string,unknown>;
    const rows=Array.isArray(decoded)?decoded:[decoded];
    if(rows.length!==payload.length) throw Error('BATCH_RESULT_COUNT_MISMATCH');
    const byId=new Map(rows.map(r=>[r.id,r]));if(byId.size!==payload.length)throw Error('DUPLICATE_RPC_RESPONSE_ID');
    const failed=payload.map(p=>({p,r:byId.get(p.id)})).find(x=>!x.r||x.r.error||!('result'in x.r));
    if(failed) {
      const message=JSON.stringify(failed.r?.error??'MISSING_ID');
      if((message.toLowerCase().includes('header not found')||message.toLowerCase().includes('request failed'))&&attempt<4){await sleep((attempt+1)*3000);continue;}
      throw Error(`RPC_ERROR:${failed.p.method}:${JSON.stringify(failed.p.params)}:${message}`);
    }
    return payload.map(p=>byId.get(p.id)!.result);
  }
  throw Error('RPC_RETRY_BUDGET_EXHAUSTED');
}
async function get(method:string,params:unknown[],endpoint=RPC):Promise<unknown>{const [v]=await batch([{method,params}],endpoint);return v;}
function header(v:any,n:bigint):Header { if(!v||BigInt(v.number)!==n||!/^0x[0-9a-f]{64}$/i.test(v.hash))throw Error('BAD_HEADER');return {number:n,hash:v.hash.toLowerCase(),timestamp:Number(BigInt(v.timestamp))}; }
async function fetchHeader(tag:string|bigint,expected?:bigint,allowFreeFallback=false):Promise<Header>{let last:unknown;for(let attempt=0;attempt<5;attempt++){try{const raw=await get('eth_getBlockByNumber',[typeof tag==='bigint'?hx(tag):tag,false]);const n=expected??BigInt((raw as any)?.number);return header(raw,n);}catch(error){last=error;await sleep((attempt+1)*1000);}}if(allowFreeFallback){try{const raw=await get('eth_getBlockByNumber',[typeof tag==='bigint'?hx(tag):tag,false],FREE_HEADER_FALLBACK_RPC);const n=expected??BigInt((raw as any)?.number);fallbackHeaderReads++;return header(raw,n);}catch(error){throw Error(`HEADER_UNAVAILABLE:${String(last)};fallback:${String(error)}`);}}throw Error(`HEADER_UNAVAILABLE:${String(last)}`);}
function decode(l:any, receiptLog=false):Omit<Flow,'timestamp'> {
 const kind=String(l.topics?.[0]).toLowerCase()===DEP?'Deposit':String(l.topics?.[0]).toLowerCase()===WDR?'Withdraw':null;
 const expectedTopics=kind==='Deposit'?3:4;
 if(String(l.address).toLowerCase()!==VAULT||(!receiptLog&&l.removed!==false)||(receiptLog&&l.removed!==undefined&&l.removed!==false)||!kind||!Array.isArray(l.topics)||l.topics.length!==expectedTopics||l.topics.some((t:any)=>typeof t!=='string'||!/^0x[0-9a-f]{64}$/i.test(t))||!/^0x[0-9a-f]{128}$/i.test(l.data)||!/^0x[0-9a-f]{64}$/i.test(l.blockHash)||!/^0x[0-9a-f]{64}$/i.test(l.transactionHash))throw Error('BAD_LOG');
 const bn=BigInt(l.blockNumber).toString(), ix=BigInt(l.logIndex).toString(), tx=l.transactionHash.toLowerCase();
 return {id:`unitas-susdu:56:${tx}:${ix}`,blockNumber:bn,blockHash:l.blockHash.toLowerCase(),transactionHash:tx,logIndex:ix,kind,assetsRaw:BigInt(`0x${l.data.slice(2,66)}`).toString(),sharesRaw:BigInt(`0x${l.data.slice(66)}`).toString()};
}
async function saveCheckpoint(next:bigint,flows:Flow[],headers:Record<string,Header>,initial:{from:bigint;to:bigint;fromHash:string}) {
 await mkdir(dirname(CHECKPOINT),{recursive:true});
 const temp=CHECKPOINT+'.tmp';
 await writeFile(temp,JSON.stringify({version:1,sourceUrl:RPC,range:{from:initial.from.toString(),to:initial.to.toString(),fromHash:initial.fromHash},nextBlock:next.toString(),flows,headers:Object.fromEntries(Object.entries(headers).map(([k,h])=>[k,{number:h.number.toString(),hash:h.hash,timestamp:h.timestamp}])),verifiedReceiptTxs,receiptSources,eventMetadata,receiptCheck:receipts,counts:{logCalls:calls,ops}},null,2));
 await rename(temp,CHECKPOINT);
}

async function main(){
 const data=FinanceStrategySchema.parse(JSON.parse(await readFile(DATA,'utf8'))) as any;
 const samples=[...data.samples].sort((a:any,b:any)=>BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:1);
 const oldFrom=BigInt(samples[0].blockNumber), oldFlow=data.flows as Flow[];
 const coverage=JSON.parse(await readFile(PINS,'utf8')).flowCollection;
 const to=BigInt(coverage.requestedRange.toBlock); // preserve the already-published tail beyond the stock endpoint
 const fromHeader=await fetchHeader(oldFrom,oldFrom);
 if(fromHeader.hash!==samples[0].blockHash.toLowerCase())throw Error('OLD_ANCHOR_HASH_MISMATCH');
 const chain=await get('eth_chainId',[]); if(chain!=='0x38')throw Error('WRONG_CHAIN');
 const probe=await get('eth_getLogs',[{address:VAULT,fromBlock:hx(oldFrom),toBlock:hx(oldFrom+CHUNK-1n),topics:[[DEP,WDR]]}]);
 if(!Array.isArray(probe)||probe.length===0)throw Error('EMPTY_KNOWN_RANGE_PROBE');
 const finalized=await fetchHeader('finalized'); if(to>finalized.number)throw Error('COVERAGE_TARGET_ABOVE_FINALIZED');
 let checkpoint:any=null;
 try { checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8')); }
 catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error(`CHECKPOINT_READ_OR_PARSE_FAILED:${String(error)}`); }
 const initial={from:oldFrom,to,fromHash:fromHeader.hash};
 if(checkpoint&&(checkpoint.range.from!==oldFrom.toString()||checkpoint.range.to!==to.toString()||checkpoint.range.fromHash!==initial.fromHash))throw Error('CHECKPOINT_RANGE_MISMATCH');
 let next=checkpoint?BigInt(checkpoint.nextBlock):oldFrom;
 let flows:Flow[]=checkpoint?.flows??[];
 const headers:Record<string,Header>=checkpoint?.headers??{};
 verifiedReceiptTxs=checkpoint?.verifiedReceiptTxs??[];
 receiptSources=checkpoint?.receiptSources??{};
 for(const tx of verifiedReceiptTxs)receiptSources[tx]??='Pocket';
 eventMetadata=checkpoint?.eventMetadata??{};
 receipts={attempted:verifiedReceiptTxs.length,matchedTransactions:verifiedReceiptTxs.length,mismatchedTransactions:0,unavailableTransactions:0};
 calls=Number(checkpoint?.counts?.logCalls??0); ops=Number(checkpoint?.counts?.ops??0);
 console.log(JSON.stringify({status:'started',script:'scripts/discovery/harvest-unitas-pocket-flows.ts',checkpoint:CHECKPOINT,from:oldFrom.toString(),to:to.toString(),nextBlock:next.toString(),oldFlows:oldFlow.length,probeLogs:probe.length,chain,finalized:finalized.number.toString()}));
 // Three in-flight batches overlap response latency. Global pacing in batch()
 // allows at most five read operations/sec; checkpoints only commit contiguous results.
 let cursor=next,failed=false;
 const completed=new Map<string,{last:bigint;flows:Flow[]}>();
 let flushing=Promise.resolve();
 const flush=()=>{
   flushing=flushing.then(async()=>{
     while(completed.has(next.toString())){
       const entry=completed.get(next.toString())!;completed.delete(next.toString());
       flows.push(...entry.flows);if(flows.length>MAX_FLOWS)throw Error('MAX_FLOWS');
       next=entry.last+1n;await saveCheckpoint(next,flows,headers,initial);
       if(calls%100===0||next>to)console.log(JSON.stringify({status:'progress',nextBlock:next.toString(),to:to.toString(),calls,ops,flows:flows.length}));
     }
   });return flushing;
 };
 const worker=async()=>{
   while(!failed&&cursor<=to){
     const ranges:Array<{lo:bigint;hi:bigint}>=[];
     for(let i=0;i<5&&cursor<=to;i++){const lo=cursor,hi=lo+CHUNK-1n<to?lo+CHUNK-1n:to;ranges.push({lo,hi});cursor=hi+1n;}
     if(calls+ranges.length>MAX_LOG_CALLS){failed=true;throw Error('MAX_LOG_CALLS');}
     calls+=ranges.length;
     try{
       const results=await batch(ranges.map(({lo,hi})=>({method:'eth_getLogs',params:[{address:VAULT,fromBlock:hx(lo),toBlock:hx(hi),topics:[[DEP,WDR]]}]})));
       const additions:Flow[]=[];
       for(let j=0;j<ranges.length;j++){
         const logs=results[j];if(!Array.isArray(logs))throw Error('BAD_LOGS_RESULT');
         for(const raw of logs){const f=decode(raw);if(BigInt(f.blockNumber)<ranges[j].lo||BigInt(f.blockNumber)>ranges[j].hi)throw Error('LOG_OUTSIDE_RANGE');additions.push({...f,timestamp:''});}
       }
       completed.set(ranges[0].lo.toString(),{last:ranges.at(-1)!.hi,flows:additions});await flush();
     }catch(error){failed=true;throw error;}
   }
 };
 const workers=await Promise.allSettled(Array.from({length:3},worker));await flushing;
 const failure=workers.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
 // Receipt metadata supplies exact event block timestamps and independently checks each log identity.
 const byTx=new Map<string,Flow[]>();for(const f of flows)byTx.set(f.transactionHash,[...(byTx.get(f.transactionHash)??[]),f]);
 const txs=[...byTx.keys()];
 const doneTx=new Set(verifiedReceiptTxs);
 for(let i=0;i<txs.length;i+=5){const group=txs.slice(i,i+5).filter(tx=>!doneTx.has(tx));if(!group.length)continue;let result=await batch(group.map(tx=>({method:'eth_getTransactionReceipt',params:[tx]})),FREE_HEADER_FALLBACK_RPC);const sources=group.map(()=> 'Blast' as 'Blast'|'Pocket');const nulls=group.map((_,k)=>result[k]===null?k:-1).filter(k=>k>=0);if(nulls.length){const fallback=await batch(nulls.map(k=>({method:'eth_getTransactionReceipt',params:[group[k]]})));nulls.forEach((k,j)=>{result[k]=fallback[j];if(fallback[j]!==null)sources[k]='Pocket';});}group.forEach((tx,k)=>{receipts.attempted++;const r:any=result[k];if(!r){receipts.unavailableTransactions++;return;}const fs=byTx.get(tx)!;const validReceipt=r.transactionHash?.toLowerCase()===tx&&r.status==='0x1'&&BigInt(r.blockNumber).toString()===fs[0].blockNumber&&String(r.blockHash).toLowerCase()===fs[0].blockHash;const localMetadata:Array<{block:string;hash:string;timestamp:string}>=[];const match=validReceipt&&fs.every(f=>{const log=(r.logs??[]).find((l:any)=>{try{const d=decode(l,true);return d.id===f.id&&d.transactionHash===tx&&d.kind===f.kind&&d.blockNumber===f.blockNumber&&d.blockHash===f.blockHash&&d.logIndex===f.logIndex&&d.assetsRaw===f.assetsRaw&&d.sharesRaw===f.sharesRaw;}catch{return false;}});if(!log||typeof log.blockTimestamp!=='string'||!/^0x[0-9a-f]+$/i.test(log.blockTimestamp))return false;const seconds=Number(BigInt(log.blockTimestamp));if(!Number.isSafeInteger(seconds)||seconds<=0)return false;localMetadata.push({block:f.blockNumber,hash:f.blockHash,timestamp:iso(seconds)});return true;});if(match){for(const m of localMetadata){const previous=eventMetadata[m.block];if(previous&&(previous.hash!==m.hash||previous.timestamp!==m.timestamp)){receipts.mismatchedTransactions++;return;}eventMetadata[m.block]={hash:m.hash,timestamp:m.timestamp};}verifiedReceiptTxs.push(tx);receiptSources[tx]=sources[k];doneTx.add(tx);receipts.matchedTransactions++;}else receipts.mismatchedTransactions++;});await saveCheckpoint(to+1n,flows,headers,initial);}
 if(receipts.mismatchedTransactions||receipts.unavailableTransactions)throw Error('RECEIPT_VALIDATION_FAILED');
 if(verifiedReceiptTxs.length!==txs.length)throw Error('RECEIPT_COVERAGE_INCOMPLETE');
 flows=flows.map(f=>{const meta=eventMetadata[f.blockNumber];if(meta){if(meta.hash!==f.blockHash)throw Error('RECEIPT_EVENT_HASH_MISMATCH');const h=headers[f.blockNumber];if(h&&(h.hash!==meta.hash||iso(h.timestamp)!==meta.timestamp))throw Error('HEADER_RECEIPT_IDENTITY_MISMATCH');return {...f,timestamp:meta.timestamp};}const h=headers[f.blockNumber];if(!h||h.hash!==f.blockHash)throw Error(`EVENT_METADATA_UNAVAILABLE:${f.blockNumber}`);return {...f,timestamp:iso(h.timestamp)};});
 const dedup=new Map<string,Flow>();for(const f of [...oldFlow,...flows]){const key=`${f.transactionHash}:${f.logIndex}`;const old=dedup.get(key);if(old&&(old.kind!==f.kind||old.assetsRaw!==f.assetsRaw||old.sharesRaw!==f.sharesRaw))throw Error('EXISTING_FLOW_CONFLICT');dedup.set(key,f);}
 const merged=[...dedup.values()].sort((a,b)=>BigInt(a.blockNumber)===BigInt(b.blockNumber)?(BigInt(a.logIndex)<BigInt(b.logIndex)?-1:1):(BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:1));
 const oldKeys=new Set(oldFlow.map(f=>`${f.transactionHash}:${f.logIndex}`));if([...oldKeys].some(k=>!flows.some(f=>`${f.transactionHash}:${f.logIndex}`===k)))throw Error('EXISTING_FLOW_NOT_RESCANNED');
 for(const old of oldFlow){const current=flows.find(f=>f.transactionHash===old.transactionHash&&f.logIndex===old.logIndex);if(!current||Date.parse(current.timestamp)!==Date.parse(old.timestamp)||current.blockHash.toLowerCase()!==old.blockHash.toLowerCase())throw Error(`EXISTING_FLOW_TIMESTAMP_OR_HASH_MISMATCH:${old.id}`);}
 const positions=new Set<string>();for(const f of merged){const k=`${f.blockNumber}:${f.logIndex}`;if(positions.has(k))throw Error('DUPLICATE_BLOCK_LOG_POSITION');positions.add(k);}
 const startH=fromHeader, endH=await fetchHeader(to,to);
 for(const s of samples){const n=BigInt(s.blockNumber);const h=await fetchHeader(n,n,true);if(h.hash!==String(s.blockHash).toLowerCase())throw Error(`SAMPLE_HASH_MISMATCH:${n}`);}
 const stableStart=await fetchHeader(oldFrom,oldFrom);const stableEnd=await fetchHeader(to,to);if(stableStart.hash!==startH.hash||stableEnd.hash!==endH.hash)throw Error('BOUNDARY_HASH_CHANGED');
 // Validate every daily stock interval against net sUSDu share movement.
 const daily=[];for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i],lo=BigInt(a.blockNumber),hi=BigInt(b.blockNumber);const actual=flows.filter(f=>BigInt(f.blockNumber)>lo&&BigInt(f.blockNumber)<=hi).reduce((s,f)=>s+(f.kind==='Deposit'?BigInt(f.sharesRaw):-BigInt(f.sharesRaw)),0n);const expected=BigInt(b.totalSupplyRaw)-BigInt(a.totalSupplyRaw);daily.push({from:lo.toString(),to:hi.toString(),actual:actual.toString(),expected:expected.toString(),match:actual===expected});}
 const dailyFailed=daily.filter(d=>!d.match);if(dailyFailed.length)throw Error(`DAILY_STOCK_RECONCILIATION_FAILED:${dailyFailed.length}`);
 data.flows=merged;data.flowCoverage={fromBlock:oldFrom.toString(),toBlock:to.toString(),toBlockHash:endH.hash,fromTime:iso(startH.timestamp),toTime:iso(endH.timestamp),observedAt:new Date().toISOString(),sourceUrl:RPC,complete:true};
 FinanceStrategySchema.parse(data);
 const temp=DATA+'.tmp';await writeFile(temp,JSON.stringify(data,null,2)+'\n');await rename(temp,DATA);
 const pins=JSON.parse(await readFile(PINS,'utf8'));
 const receiptSourceCounts=Object.values(receiptSources).reduce((o,s)=>({...o,[s]:(o[s]??0)+1}),{} as Record<string,number>);
 pins.flowCollection={...coverage,sourceUrl:RPC,requestedDays:60,requestedRange:{fromBlock:oldFrom.toString(),toBlock:to.toString(),fromTime:iso(startH.timestamp),toTime:iso(endH.timestamp)},coveredRange:{fromBlock:oldFrom.toString(),toBlock:to.toString(),fromTime:iso(startH.timestamp),toTime:iso(endH.timestamp)},coverageCompleteWithinCoveredRange:true,partialHistory:false,flowCount:merged.length,newFlowCount:flows.length,eventCounts:merged.reduce((o,f)=>({...o,[f.kind]:(o[f.kind]??0)+1}),{} as Record<string,number>),logRequests:calls,maxLogRequests:MAX_LOG_CALLS,requestSummary:{observedOperationsIncludingRetries:ops,maxOperations:MAX_OPS,logRangesAttempted:calls},headerVerification:{eventBlocks:new Set(flows.map(f=>f.blockNumber)).size,directHeaderReads:Object.keys(headers).length,receiptReportedBlockMetadataBlocks:Object.keys(eventMetadata).length,stockSampleAnchorsVerified:samples.length,freeFallbackHeaderReads:fallbackHeaderReads,verified:true},receiptCheck:{...receipts,uniqueReceiptSources:receiptSourceCounts},dailyReconciliation:{days:daily.length,matched:daily.length,failed:0},privacyProjection:'Deposit/Withdraw transaction identity, timestamp, block hash, log index, assetsRaw and sharesRaw only; sender, owner and receiver topics omitted.',attribution:'shared_unitas_strategy; these are not Primus-specific flows.'};
 await writeFile(PINS+'.tmp',JSON.stringify(pins,null,2)+'\n');await rename(PINS+'.tmp',PINS);
 console.log(JSON.stringify({status:'complete',flows:merged.length,newFlows:flows.length,calls,ops,receipts,dailyReconciled:daily.length,coverage:data.flowCoverage}));
}
async function repairRange(){
 const fromArg=process.argv.find(a=>a.startsWith('--repair-from='))?.split('=')[1];
 const toArg=process.argv.find(a=>a.startsWith('--repair-to='))?.split('=')[1];
 if(!fromArg||!toArg)throw Error('REPAIR_RANGE_REQUIRED');
 const from=BigInt(fromArg),to=BigInt(toArg);if(from>=to)throw Error('BAD_REPAIR_RANGE');
 const checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8'));
 const oldFlows=checkpoint.flows as Flow[];
 const repair=checkpoint.repair;
 if(repair&&(repair.from!==from.toString()||repair.to!==to.toString()||repair.sourceUrl!==FREE_NOWNODES_RPC))throw Error('REPAIR_CHECKPOINT_MISMATCH');
 let next=repair?BigInt(repair.nextBlock):from+1n;
 const additions:Flow[]=repair?.flows??[];
 let requests=Number(repair?.requests??0);
 console.log(JSON.stringify({status:'repair_started',sourceUrl:FREE_NOWNODES_RPC,from:from.toString(),to:to.toString(),nextBlock:next.toString(),existingFlows:oldFlows.length,repairFlows:additions.length}));
 while(next<=to){
  const high=next+CHUNK-1n<to?next+CHUNK-1n:to;
  const result=await batch([{method:'eth_getLogs',params:[{address:VAULT,fromBlock:hx(next),toBlock:hx(high),topics:[[DEP,WDR]]}]}],FREE_NOWNODES_RPC);
  requests++;
  if(!Array.isArray(result[0]))throw Error('BAD_REPAIR_LOGS_RESULT');
  for(const raw of result[0] as any[]){const f=decode(raw);if(BigInt(f.blockNumber)<next||BigInt(f.blockNumber)>high)throw Error('REPAIR_LOG_OUTSIDE_RANGE');additions.push({...f,timestamp:''});}
  const seen=new Map(oldFlows.map(f=>[`${f.transactionHash}:${f.logIndex}`,f]));
  for(const f of additions){const key=`${f.transactionHash}:${f.logIndex}`,old=seen.get(key);if(old&&(old.kind!==f.kind||old.assetsRaw!==f.assetsRaw||old.sharesRaw!==f.sharesRaw))throw Error('REPAIR_SEMANTIC_CONFLICT');seen.set(key,f);}
  next=high+1n;const temp=CHECKPOINT+'.tmp';checkpoint.repair={sourceUrl:FREE_NOWNODES_RPC,from:from.toString(),to:to.toString(),nextBlock:next.toString(),requests,flows:additions};
  await writeFile(temp,JSON.stringify(checkpoint,null,2));await rename(temp,CHECKPOINT);
  console.log(JSON.stringify({status:'repair_progress',nextBlock:next.toString(),requests,repairFlows:additions.length}));
 }
 const net=additions.reduce((s,f)=>s+(f.kind==='Deposit'?BigInt(f.sharesRaw):-BigInt(f.sharesRaw)),0n);
 console.log(JSON.stringify({status:'repair_complete',sourceUrl:FREE_NOWNODES_RPC,from:from.toString(),to:to.toString(),requests,repairFlows:additions.length,depositShares:additions.filter(f=>f.kind==='Deposit').length,withdrawShares:additions.filter(f=>f.kind==='Withdraw').length,netShareDeltaRaw:net.toString(),newSemanticFlows:additions.filter(f=>!oldFlows.some(o=>o.transactionHash===f.transactionHash&&o.logIndex===f.logIndex)).length}));
}
async function repairAddressRange(){
 const fromArg=process.argv.find(a=>a.startsWith('--repair-from='))?.split('=')[1],toArg=process.argv.find(a=>a.startsWith('--repair-to='))?.split('=')[1];
 if(!fromArg||!toArg)throw Error('REPAIR_RANGE_REQUIRED');
 const from=BigInt(fromArg),to=BigInt(toArg);if(from>=to)throw Error('BAD_REPAIR_RANGE');
 const checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8'));
 const pass=Number(process.argv.find(a=>a.startsWith('--repair-pass='))?.split('=')[1]??'1');if(!Number.isInteger(pass)||pass<1||pass>5)throw Error('BAD_REPAIR_PASS');const stateKey=pass===1?'repairAddress':`repairAddressPass${pass}`;
 if(checkpoint[stateKey]&&(checkpoint[stateKey].from!==from.toString()||checkpoint[stateKey].to!==to.toString()))throw Error('ADDRESS_REPAIR_RANGE_MISMATCH');
 if(!checkpoint[stateKey]){if(checkpoint.repair){checkpoint.repairHistory=[...(checkpoint.repairHistory??[]),checkpoint.repair];delete checkpoint.repair;}const probe=pass===1?await readFile(resolve(ROOT,'.local/research/abi-day-probe.json'),'utf8').then(JSON.parse).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}):null;checkpoint[stateKey]={sourceUrl:RPC,query:'eth_getLogs(address only); Deposit/Withdraw topics decoded from contract logs',pass,from:from.toString(),to:to.toString(),nextBlock:(from+1n).toString(),requests:0,flows:probe?.extra??[]};}
 const state=checkpoint[stateKey];let next=BigInt(state.nextBlock);let flows:Flow[]=state.flows;let requests=Number(state.requests??0);ops=Number(checkpoint.counts?.ops??0);
 const oldFlows=checkpoint.flows as Flow[];console.log(JSON.stringify({status:'address_repair_started',sourceUrl:RPC,from:from.toString(),to:to.toString(),nextBlock:next.toString(),prefilledFlows:flows.length,oldFlows:oldFlows.length}));
 const cursor={value:next};let failed=false;const complete=new Map<string,{last:bigint;flows:Flow[]}>();let flushing=Promise.resolve();
 const flush=()=>{flushing=flushing.then(async()=>{while(complete.has(next.toString())){const x=complete.get(next.toString())!;complete.delete(next.toString());const byId=new Map(flows.map(f=>[f.id,f]));for(const f of x.flows){const prior=byId.get(f.id);if(prior&&(prior.kind!==f.kind||prior.assetsRaw!==f.assetsRaw||prior.sharesRaw!==f.sharesRaw||prior.blockHash!==f.blockHash))throw Error('ADDRESS_REPAIR_CONFLICT');if(!prior){flows.push(f);byId.set(f.id,f);}}next=x.last+1n;state.nextBlock=next.toString();state.requests=requests;state.flows=flows;const tmp=CHECKPOINT+'.tmp';await writeFile(tmp,JSON.stringify(checkpoint,null,2));await rename(tmp,CHECKPOINT);if(requests%50===0||next>to)console.log(JSON.stringify({status:'address_repair_progress',pass,nextBlock:next.toString(),requests,flows:flows.length}));}});return flushing;};
 const worker=async()=>{while(!failed&&cursor.value<=to){const low=cursor.value,high=low+CHUNK-1n<to?low+CHUNK-1n:to;cursor.value=high+1n;requests++;try{const result=await batch([{method:'eth_getLogs',params:[{address:VAULT,fromBlock:hx(low),toBlock:hx(high)}]}]);if(!Array.isArray(result[0]))throw Error('BAD_ADDRESS_LOG_RESULT');const additions:Flow[]=[];for(const log of result[0] as any[]){const topic=String(log.topics?.[0]).toLowerCase();if(topic!==DEP&&topic!==WDR)continue;const f=decode(log);if(BigInt(f.blockNumber)<low||BigInt(f.blockNumber)>high)throw Error('ADDRESS_LOG_OUTSIDE_RANGE');additions.push({...f,timestamp:''});}complete.set(low.toString(),{last:high,flows:additions});await flush();}catch(error){failed=true;throw error;}}};
 const results=await Promise.allSettled(Array.from({length:3},worker));await flushing;const rejected=results.find(x=>x.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;
 const merged=new Map(oldFlows.map(f=>[f.id,f]));let net=0n;for(const f of flows){const old=merged.get(f.id);if(old&&(old.kind!==f.kind||old.assetsRaw!==f.assetsRaw||old.sharesRaw!==f.sharesRaw||old.blockHash!==f.blockHash))throw Error('ADDRESS_REPAIR_OLD_FLOW_CONFLICT');if(!old)merged.set(f.id,f);net+=f.kind==='Deposit'?BigInt(f.sharesRaw):-BigInt(f.sharesRaw);}
 console.log(JSON.stringify({status:'address_repair_complete',pass,sourceUrl:RPC,from:from.toString(),to:to.toString(),requests,repairFlows:flows.length,newSemanticFlows:flows.filter(f=>!oldFlows.some(o=>o.id===f.id)).length,netShareDeltaRaw:net.toString(),oldFlowCount:oldFlows.length,unionFlowCount:merged.size}));
}
async function repairTransferRange(){
 const from=BigInt(process.argv.find(a=>a.startsWith('--repair-from='))?.split('=')[1]??'0'),to=BigInt(process.argv.find(a=>a.startsWith('--repair-to='))?.split('=')[1]??'0');if(from<=0n||from>=to)throw Error('REPAIR_RANGE_REQUIRED');
 const checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8'));let state=checkpoint.repairTransferScan;
 if(state&&(state.from!==from.toString()||state.to!==to.toString()))throw Error('TRANSFER_REPAIR_RANGE_MISMATCH');
 if(!state)state=checkpoint.repairTransferScan={sourceUrl:RPC,from:from.toString(),to:to.toString(),nextBlock:(from+1n).toString(),requests:0,events:[]};
 let next=BigInt(state.nextBlock),requests=Number(state.requests),events=state.events as Array<{blockNumber:string;transactionHash:string;logIndex:string;mint:boolean;burn:boolean;amountRaw:string}>;ops=Number(checkpoint.counts?.ops??0);const cursor={v:next};let failed=false;const complete=new Map<string,{last:bigint;events:typeof events}>();let flushing=Promise.resolve();
 const flush=()=>{flushing=flushing.then(async()=>{while(complete.has(next.toString())){const x=complete.get(next.toString())!;complete.delete(next.toString());events.push(...x.events);next=x.last+1n;state.nextBlock=next.toString();state.requests=requests;state.events=events;const tmp=CHECKPOINT+'.tmp';await writeFile(tmp,JSON.stringify(checkpoint,null,2));await rename(tmp,CHECKPOINT);}});return flushing;};
 const worker=async()=>{while(!failed&&cursor.v<=to){const low=cursor.v,high=low+CHUNK-1n<to?low+CHUNK-1n:to;cursor.v=high+1n;requests++;try{const result=await batch([{method:'eth_getLogs',params:[{address:VAULT,fromBlock:hx(low),toBlock:hx(high)}]}]);if(!Array.isArray(result[0]))throw Error('BAD_TRANSFER_SCAN');const found:typeof events=[];for(const l of result[0] as any[]){if(String(l.topics?.[0]).toLowerCase()!==TRANSFER)continue;if(String(l.address).toLowerCase()!==VAULT||!Array.isArray(l.topics)||l.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(l.topics[1])||!/^0x[0-9a-f]{64}$/i.test(l.topics[2])||!/^0x[0-9a-f]{64}$/i.test(l.data)||!/^0x[0-9a-f]{64}$/i.test(l.transactionHash))throw Error('BAD_TRANSFER_LOG');const mint=BigInt(l.topics[1])===0n,burn=BigInt(l.topics[2])===0n;if(mint||burn)found.push({blockNumber:BigInt(l.blockNumber).toString(),transactionHash:String(l.transactionHash).toLowerCase(),logIndex:BigInt(l.logIndex).toString(),mint,burn,amountRaw:BigInt(l.data).toString()});}complete.set(low.toString(),{last:high,events:found});await flush();}catch(e){failed=true;throw e;}}};
 const results=await Promise.allSettled(Array.from({length:3},worker));await flushing;const bad=results.find(x=>x.status==='rejected');if(bad?.status==='rejected')throw bad.reason;
 const intervals:[[bigint,bigint],[bigint,bigint],[bigint,bigint]]=[[130221088n,130412963n],[130412963n,130604920n],[130604920n,130796866n]];
 console.log(JSON.stringify({status:'transfer_scan_complete',sourceUrl:RPC,from:from.toString(),to:to.toString(),requests,transferMintBurnEvents:events.length,intervals:intervals.map(([a,b])=>({from:a.toString(),to:b.toString(),net:events.filter(e=>BigInt(e.blockNumber)>a&&BigInt(e.blockNumber)<=b).reduce((s,e)=>s+(e.mint?BigInt(e.amountRaw):0n)-(e.burn?BigInt(e.amountRaw):0n),0n).toString()}))}));
}
async function repairLockedRange(){
 const from=BigInt(process.argv.find(a=>a.startsWith('--repair-from='))?.split('=')[1]??'0'),to=BigInt(process.argv.find(a=>a.startsWith('--repair-to='))?.split('=')[1]??'0');if(from<=0n||from>=to)throw Error('REPAIR_RANGE_REQUIRED');
 const checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8'));let state=checkpoint.repairLockedScan;
 if(state&&(state.from!==from.toString()||state.to!==to.toString()))throw Error('LOCKED_REPAIR_RANGE_MISMATCH');
 if(!state)state=checkpoint.repairLockedScan={sourceUrl:RPC,from:from.toString(),to:to.toString(),nextBlock:(from+1n).toString(),requests:0,events:[]};
 let next=BigInt(state.nextBlock),requests=Number(state.requests),events=state.events as Array<{blockNumber:string;transactionHash:string;logIndex:string;toZero:boolean;amountRaw:string}>;ops=Number(checkpoint.counts?.ops??0);const cursor={v:next};let failed=false;const complete=new Map<string,{last:bigint;events:typeof events}>();let flushing=Promise.resolve();
 const flush=()=>{flushing=flushing.then(async()=>{while(complete.has(next.toString())){const x=complete.get(next.toString())!;complete.delete(next.toString());events.push(...x.events);next=x.last+1n;state.nextBlock=next.toString();state.requests=requests;state.events=events;const tmp=CHECKPOINT+'.tmp';await writeFile(tmp,JSON.stringify(checkpoint,null,2));await rename(tmp,CHECKPOINT);}});return flushing;};
 const worker=async()=>{while(!failed&&cursor.v<=to){const low=cursor.v,high=low+CHUNK-1n<to?low+CHUNK-1n:to;cursor.v=high+1n;requests++;try{const result=await batch([{method:'eth_getLogs',params:[{address:VAULT,fromBlock:hx(low),toBlock:hx(high),topics:[[LOCKED_REDISTRIBUTED]]}]}]);if(!Array.isArray(result[0]))throw Error('BAD_LOCKED_RESULT');const found:typeof events=[];for(const l of result[0] as any[]){if(String(l.address).toLowerCase()!==VAULT||!Array.isArray(l.topics)||l.topics.length!==3||String(l.topics[0]).toLowerCase()!==LOCKED_REDISTRIBUTED||!/^0x[0-9a-f]{64}$/i.test(l.topics[2])||!/^0x[0-9a-f]{64}$/i.test(l.data)||!/^0x[0-9a-f]{64}$/i.test(l.transactionHash))throw Error('BAD_LOCKED_LOG');found.push({blockNumber:BigInt(l.blockNumber).toString(),transactionHash:String(l.transactionHash).toLowerCase(),logIndex:BigInt(l.logIndex).toString(),toZero:BigInt(l.topics[2])===0n,amountRaw:BigInt(l.data).toString()});}complete.set(low.toString(),{last:high,events:found});await flush();}catch(e){failed=true;throw e;}}};
 const results=await Promise.allSettled(Array.from({length:3},worker));await flushing;const bad=results.find(x=>x.status==='rejected');if(bad?.status==='rejected')throw bad.reason;
 console.log(JSON.stringify({status:'locked_scan_complete',from:from.toString(),to:to.toString(),requests,events:events.length,zeroAddressBurns:events.filter(e=>e.toZero).length,zeroAddressBurnNetRaw:events.filter(e=>e.toZero).reduce((s,e)=>s+BigInt(e.amountRaw),0n).toString(),intervals:[[130221088n,130412963n],[130412963n,130604920n],[130604920n,130796866n]].map(([a,b])=>({from:a.toString(),to:b.toString(),burnRaw:events.filter(e=>e.toZero&&BigInt(e.blockNumber)>a&&BigInt(e.blockNumber)<=b).reduce((s,e)=>s+BigInt(e.amountRaw),0n).toString()}))}));
}
async function verifyUnionReceipts(){
 const checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8'));
 const bisection=await readFile(resolve(ROOT,'.local/research/supply-bisection-results.json'),'utf8').then(JSON.parse).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return {extra:[]};throw error;});
 const datasets=[FinanceStrategySchema.parse(JSON.parse(await readFile(DATA,'utf8'))).flows,checkpoint.flows,...(checkpoint.repairAddress?.flows?[checkpoint.repairAddress.flows]:[]),...(checkpoint.repairAddressPass2?.flows?[checkpoint.repairAddressPass2.flows]:[]),bisection.extra].filter(Array.isArray) as Flow[][];
 const byId=new Map<string,Flow>();for(const rows of datasets)for(const f of rows){const prior=byId.get(f.id);if(prior&&(prior.kind!==f.kind||prior.assetsRaw!==f.assetsRaw||prior.sharesRaw!==f.sharesRaw||prior.blockHash!==f.blockHash))throw Error(`UNION_FLOW_SEMANTIC_CONFLICT:${f.id}`);if(!prior)byId.set(f.id,f);}
 const flows=[...byId.values()],baseIds=new Set((checkpoint.flows as Flow[]).map(f=>f.id));
 const byTx=new Map<string,Flow[]>();for(const f of flows)byTx.set(f.transactionHash,[...(byTx.get(f.transactionHash)??[]),f]);
 const txs=[...byTx.keys()];const previouslyVerified=new Set(checkpoint.verifiedReceiptTxs??[]);
 let verified:string[]=checkpoint.unionVerifiedReceiptTxs??txs.filter(tx=>previouslyVerified.has(tx)&&byTx.get(tx)!.every(f=>baseIds.has(f.id)));
 let sources:Record<string,'Pocket'|'Blast'>=checkpoint.unionReceiptSources??Object.fromEntries(verified.map(tx=>[tx,checkpoint.receiptSources?.[tx]??'Pocket']));
 let metadata:Record<string,{hash:string;timestamp:string}>=checkpoint.unionEventMetadata??{...(checkpoint.eventMetadata??{})};
 const verifiedSet=new Set(verified);let stats=checkpoint.unionReceiptCheck??{attempted:verified.length,matchedTransactions:verified.length,mismatchedTransactions:0,unavailableTransactions:0};ops=Math.max(Number(checkpoint.counts?.ops??0),Number(checkpoint.unionOps??0));
 const persist=async()=>{checkpoint.unionVerifiedReceiptTxs=verified;checkpoint.unionReceiptSources=sources;checkpoint.unionEventMetadata=metadata;checkpoint.unionReceiptCheck=stats;checkpoint.unionOps=ops;const tmp=`${CHECKPOINT}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(checkpoint,null,2));await rename(tmp,CHECKPOINT);};
 console.log(JSON.stringify({status:'union_receipts_started',uniqueFlows:flows.length,uniqueTransactions:txs.length,alreadyVerified:verified.length,ops}));
 for(let i=0;i<txs.length;i+=5){const group=txs.slice(i,i+5).filter(tx=>!verifiedSet.has(tx));if(!group.length)continue;let result=await batch(group.map(tx=>({method:'eth_getTransactionReceipt',params:[tx]})),FREE_HEADER_FALLBACK_RPC);let source:Array<'Blast'|'Pocket'>=group.map(()=> 'Blast');const nulls=group.map((_,k)=>result[k]===null?k:-1).filter(k=>k>=0);if(nulls.length){const fallback=await batch(nulls.map(k=>({method:'eth_getTransactionReceipt',params:[group[k]]})));nulls.forEach((k,j)=>{result[k]=fallback[j];if(fallback[j]!==null)source[k]='Pocket';});}
  for(let k=0;k<group.length;k++){const tx=group[k],r:any=result[k];stats.attempted++;if(!r){stats.unavailableTransactions++;continue;}const fs=byTx.get(tx)!;if(r.transactionHash?.toLowerCase()!==tx||r.status!=='0x1'||BigInt(r.blockNumber).toString()!==fs[0].blockNumber||String(r.blockHash).toLowerCase()!==fs[0].blockHash){stats.mismatchedTransactions++;continue;}const local:Array<{block:string;hash:string;timestamp:string}>=[];let match=true;for(const f of fs){const l=(r.logs??[]).find((x:any)=>{try{const d=decode(x,true);return d.id===f.id&&d.transactionHash===tx&&d.kind===f.kind&&d.blockNumber===f.blockNumber&&d.blockHash===f.blockHash&&d.logIndex===f.logIndex&&d.assetsRaw===f.assetsRaw&&d.sharesRaw===f.sharesRaw;}catch{return false;}});if(!l||typeof l.blockTimestamp!=='string'||!/^0x[0-9a-f]+$/i.test(l.blockTimestamp)){match=false;break;}const seconds=Number(BigInt(l.blockTimestamp));if(!Number.isSafeInteger(seconds)||seconds<=0){match=false;break;}local.push({block:f.blockNumber,hash:f.blockHash,timestamp:iso(seconds)});}
   if(!match){stats.mismatchedTransactions++;continue;}let conflict=false;for(const m of local){const old=metadata[m.block];if(old&&(old.hash!==m.hash||old.timestamp!==m.timestamp)){conflict=true;break;}}if(conflict){stats.mismatchedTransactions++;continue;}for(const m of local)metadata[m.block]=m;verified.push(tx);verifiedSet.add(tx);sources[tx]=source[k];stats.matchedTransactions++;
  }
  await persist();
 }
 const unresolved=txs.filter(tx=>!verifiedSet.has(tx));if(unresolved.length)throw Error(`UNION_RECEIPTS_UNRESOLVED:${unresolved.length}`);
 const out=flows.map(f=>{const m=metadata[f.blockNumber];if(!m||m.hash!==f.blockHash)throw Error(`UNION_EVENT_METADATA_MISSING:${f.blockNumber}`);return {...f,timestamp:m.timestamp};});
 const oldFlows=JSON.parse(await readFile(DATA,'utf8')).flows as Flow[];for(const f of oldFlows){const x=out.find(y=>y.id===f.id);if(!x||x.blockHash!==f.blockHash||Date.parse(x.timestamp)!==Date.parse(f.timestamp))throw Error(`OLD_FLOW_RECEIPT_METADATA_MISMATCH:${f.id}`);}
 const sourceCounts=Object.values(sources).reduce((o,s)=>({...o,[s]:(o[s]??0)+1}),{} as Record<string,number>);checkpoint.unionReceiptStatsFinal={uniqueTransactions:txs.length,verifiedTransactions:verified.length,unresolvedTransactions:unresolved.length,sourceCounts,uniqueEventBlocks:new Set(flows.map(f=>f.blockNumber)).size,receiptMetadataBlocks:Object.keys(metadata).length};await persist();
 console.log(JSON.stringify({status:'union_receipts_complete',flows:out.length,transactions:txs.length,stats,sourceCounts,eventMetadataBlocks:Object.keys(metadata).length}));
}
async function finalizeUnion(){
 const checkpoint=JSON.parse(await readFile(CHECKPOINT,'utf8'));
 const bisection=await readFile(resolve(ROOT,'.local/research/supply-bisection-results.json'),'utf8').then(JSON.parse).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return {extra:[]};throw error;});
 const rows=[FinanceStrategySchema.parse(JSON.parse(await readFile(DATA,'utf8'))).flows,checkpoint.flows,...(checkpoint.repairAddress?.flows?[checkpoint.repairAddress.flows]:[]),...(checkpoint.repairAddressPass2?.flows?[checkpoint.repairAddressPass2.flows]:[]),bisection.extra].filter(Array.isArray) as Flow[][];
 const map=new Map<string,Flow>();for(const list of rows)for(const f of list){const old=map.get(f.id);if(old&&(old.kind!==f.kind||old.blockHash!==f.blockHash||old.assetsRaw!==f.assetsRaw||old.sharesRaw!==f.sharesRaw))throw Error(`FINAL_SEMANTIC_CONFLICT:${f.id}`);if(!old)map.set(f.id,f);}
 const flows=[...map.values()];const dataset=FinanceStrategySchema.parse(JSON.parse(await readFile(DATA,'utf8'))) as any;
 const receipts=new Set<string>(checkpoint.unionVerifiedReceiptTxs??[]),txs=new Set(flows.map(f=>f.transactionHash));if(receipts.size!==txs.size||[...txs].some(tx=>!receipts.has(tx)))throw Error(`FINAL_RECEIPT_COVERAGE_MISMATCH:${receipts.size}/${txs.size}`);
 const metadata=checkpoint.unionEventMetadata as Record<string,{hash:string;timestamp:string}>;for(const f of flows){const m=metadata[f.blockNumber];if(!m||m.hash!==f.blockHash||!Number.isFinite(Date.parse(m.timestamp)))throw Error(`FINAL_RECEIPT_METADATA_MISMATCH:${f.id}`);f.timestamp=m.timestamp;}
 const sortedSamples=[...dataset.samples].sort((a:any,b:any)=>BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:1);
 for(const sample of sortedSamples){const n=BigInt(sample.blockNumber);const h=await fetchHeader(n,n,true);if(h.hash!==String(sample.blockHash).toLowerCase())throw Error(`FINAL_SAMPLE_HASH_MISMATCH:${n}`);}
 const oldFrom=BigInt(sortedSamples[0].blockNumber);const previousPins=JSON.parse(await readFile(PINS,'utf8'));const oldCoverage=previousPins.flowCollection;const to=BigInt(oldCoverage.requestedRange.toBlock);const finalized=await fetchHeader('finalized');if(to>finalized.number)throw Error('FINAL_TARGET_NOT_FINALIZED');
 const startH=await fetchHeader(oldFrom,oldFrom);if(startH.hash!==String(sortedSamples[0].blockHash).toLowerCase())throw Error('FINAL_START_HASH_MISMATCH');const endH=await fetchHeader(to,to);const stableStart=await fetchHeader(oldFrom,oldFrom);const stableEnd=await fetchHeader(to,to);if(startH.hash!==stableStart.hash||endH.hash!==stableEnd.hash)throw Error('FINAL_BOUNDARY_HASH_CHANGED');
 for(const old of dataset.flows as Flow[]){const current=flows.find(f=>f.id===old.id);if(!current||current.blockHash!==old.blockHash||Date.parse(current.timestamp)!==Date.parse(old.timestamp))throw Error(`FINAL_OLD_FLOW_MISMATCH:${old.id}`);}
 const oldIds=new Set((dataset.flows as Flow[]).map(f=>f.id));for(const old of dataset.flows as Flow[])if(!map.has(old.id))throw Error(`FINAL_OLD_FLOW_MISSING:${old.id}`);
 const positions=new Set<string>();for(const f of flows){const p=`${f.blockNumber}:${f.logIndex}`;if(positions.has(p))throw Error(`FINAL_DUPLICATE_BLOCK_LOG_POSITION:${p}`);positions.add(p);}
 const daily=[];for(let i=1;i<sortedSamples.length;i++){const a=sortedSamples[i-1],b=sortedSamples[i],lo=BigInt(a.blockNumber),hi=BigInt(b.blockNumber);const actual=flows.filter(f=>BigInt(f.blockNumber)>lo&&BigInt(f.blockNumber)<=hi).reduce((s,f)=>s+(f.kind==='Deposit'?BigInt(f.sharesRaw):-BigInt(f.sharesRaw)),0n),expected=BigInt(b.totalSupplyRaw)-BigInt(a.totalSupplyRaw);daily.push({fromBlock:lo.toString(),toBlock:hi.toString(),actualSharesRaw:actual.toString(),stockDeltaSharesRaw:expected.toString(),match:actual===expected});}
 const bad=daily.filter(d=>!d.match);if(daily.length!==60||bad.length)throw Error(`FINAL_DAILY_RECONCILIATION_FAILED:${bad.length}/${daily.length}`);
 dataset.flows=flows.sort((a,b)=>BigInt(a.blockNumber)===BigInt(b.blockNumber)?(BigInt(a.logIndex)<BigInt(b.logIndex)?-1:1):(BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:1));dataset.flowCoverage={fromBlock:oldFrom.toString(),toBlock:to.toString(),toBlockHash:endH.hash,fromTime:iso(startH.timestamp),toTime:iso(endH.timestamp),observedAt:new Date().toISOString(),sourceUrl:RPC,complete:true};FinanceStrategySchema.parse(dataset);
 const counts=flows.reduce((o,f)=>({...o,[f.kind]:(o[f.kind]??0)+1}),{} as Record<string,number>);const receiptSources=Object.values(checkpoint.unionReceiptSources??{}).reduce((o,s)=>({...o,[s]:(o[s]??0)+1}),{} as Record<string,number>);
 previousPins.flowCollection={...oldCoverage,sourceUrl:RPC,requestedDays:60,requestedRange:{fromBlock:oldFrom.toString(),toBlock:to.toString(),fromTime:iso(startH.timestamp),toTime:iso(endH.timestamp)},coveredRange:{fromBlock:oldFrom.toString(),toBlock:to.toString(),fromTime:iso(startH.timestamp),toTime:iso(endH.timestamp)},coverageCompleteWithinCoveredRange:true,partialHistory:false,flowCount:flows.length,newFlowCount:flows.length-oldIds.size,eventCounts:counts,logRequests:Number(checkpoint.counts?.logCalls??0),maxLogRequests:MAX_LOG_CALLS,requestSummary:{initialOperationCountIncludingRetries:Number(checkpoint.counts?.ops??0),receiptOperationCountIncludingRetries:Number(checkpoint.unionOps??0),initialTopicRangeQueries:Number(checkpoint.counts?.logCalls??0),addressOnlyRepairRanges:(checkpoint.repairAddress?.requests??0)+(checkpoint.repairAddressPass2?.requests??0),lockedRedistributedTopicRanges:checkpoint.repairLockedScan?.requests??0,independentNownodesRanges:(checkpoint.repairHistory??[]).reduce((s:any,r:any)=>s+(r.requests??0),0)},headerVerification:{eventBlocks:new Set(flows.map(f=>f.blockNumber)).size,directEventHeaderRecords:Object.keys(checkpoint.headers??{}).length,receiptReportedBlockMetadataBlocks:Object.keys(checkpoint.unionEventMetadata??{}).length,stockSampleAnchorsVerified:sortedSamples.length,freeFallbackHeaderReads:fallbackHeaderReads,allReceiptIdentitiesMatched:true,verified:true},receiptCheck:{attempted:txs.size,matchedTransactions:receipts.size,mismatchedTransactions:0,unavailableTransactions:0,uniqueReceiptSources:receiptSources},dailyReconciliation:{days:daily.length,matched:daily.length,failed:0,intervals:daily},privacyProjection:'Deposit/Withdraw transaction identity, timestamp, block hash, log index, assetsRaw and sharesRaw only; sender, owner and receiver topics omitted.',attribution:'shared_unitas_strategy; these are not Primus-specific flows.',queryCoverageNote:'The original topic-filtered eth_getLogs queries returned incomplete partial event sets on several ranges. Address-only scans and a supply-bisected recovery were unioned by transactionHash/logIndex; coverage is supported by exact receipt identities and all 60 retained totalSupply deltas.'};
 const dataTmp=`${DATA}.${process.pid}.tmp`,pinsTmp=`${PINS}.${process.pid}.tmp`;await writeFile(dataTmp,JSON.stringify(dataset,null,2)+'\n');await rename(dataTmp,DATA);await writeFile(pinsTmp,JSON.stringify(previousPins,null,2)+'\n');await rename(pinsTmp,PINS);
 console.log(JSON.stringify({status:'finalized',flowCount:flows.length,newFlows:flows.length-oldIds.size,eventCounts:counts,verifiedReceipts:receipts.size,receiptSources,dailyReconciled:daily.length,coverage:dataset.flowCoverage}));
}
async function withCheckpointLock(run:()=>Promise<void>){
 const path=CHECKPOINT+'.lock',token=randomUUID();await mkdir(dirname(path),{recursive:true});
 let handle;
 for(let attempt=0;attempt<3;attempt++){
  try{handle=await open(path,'wx',0o600);break;}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const content=await readFile(path,'utf8');let owner;
   try{owner=JSON.parse(content);}catch{throw Error('CHECKPOINT_LOCK_INVALID');}
   if(!Number.isInteger(owner.pid)||owner.pid<1)throw Error('CHECKPOINT_LOCK_INVALID');
   let active=true;try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')active=false;else throw e;}
   if(active)throw Error('CHECKPOINT_WRITER_ALREADY_RUNNING');
   if(await readFile(path,'utf8')===content)await unlink(path);
  }
 }
 if(!handle)throw Error('CHECKPOINT_LOCK_UNAVAILABLE');
 await handle.writeFile(JSON.stringify({pid:process.pid,token}));
 try{await run();}finally{
  await handle.close();
  const current=await readFile(path,'utf8').then(JSON.parse).catch(()=>null);
  if(current?.token===token)await unlink(path);
 }
}
const action=process.argv.find(a=>a==='--repair-range');
const addressAction=process.argv.find(a=>a==='--repair-address-range');
const transferAction=process.argv.find(a=>a==='--repair-transfer-range');
const lockedAction=process.argv.find(a=>a==='--repair-locked-range');
const receiptsAction=process.argv.find(a=>a==='--verify-union-receipts');
const finalizeAction=process.argv.find(a=>a==='--finalize-union');
withCheckpointLock(()=>finalizeAction?finalizeUnion():receiptsAction?verifyUnionReceipts():lockedAction?repairLockedRange():transferAction?repairTransferRange():addressAction?repairAddressRange():action?repairRange():main()).catch(e=>{console.error(JSON.stringify({status:'paused',error:e instanceof Error?e.message:String(e),checkpoint:CHECKPOINT,calls,ops}));process.exitCode=1;});
