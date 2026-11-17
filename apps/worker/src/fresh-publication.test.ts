import{it,expect}from'vitest';
import{ObservationSetSchema}from'@primusscope/api-schema';
import recorded from'../../../data/observations/current.json';
import{freshPublication}from'./indexer';
import{sourceFor,codeHash,type Source}from'./registry';
const template=ObservationSetSchema.parse(recorded),hash='0x'+'11'.repeat(32),collector={mode:'scheduled' as const,provider:'vercel_cron' as const,intervalMinutes:60,runUrl:null};
const source=(domain:'finance'|'network',snapshot:typeof template):Source=>{const s=sourceFor(domain,snapshot);return{...s,contracts:s.contracts.map(c=>({...c,proxyCodeSha256:codeHash('0x1234'),implementationCodeSha256:codeHash('0x1234')}))};};
const rpcFor=(mismatch=false)=>(domain:'finance'|'network')=>({requestsMade:0,async call(method:string,args:unknown[]){
 if(method==='eth_chainId')return domain==='finance'?'0x38':'0x2105';
 if(method==='eth_getBlockByNumber')return{number:'0x3b9aca00',hash:mismatch?'0x'+'33'.repeat(32):hash,parentHash:'0x'+'22'.repeat(32),timestamp:'0x'+Math.floor(Date.parse('2026-11-17T00:00:00Z')/1000).toString(16)};
 if(method==='eth_getCode')return'0x1234';
 if(method==='eth_getStorageAt'){const pin=source(domain,template).contracts.find(c=>c.address===args[0])!;return'0x'+'0'.repeat(24)+pin.implementation.slice(2);}
 if(method==='eth_getLogs')return[];throw new Error('Unexpected RPC');
}});
it('starts a fresh source slice at verified chain heads, without carrying historical events or querying Neon',async()=>{
 const pub=await freshPublication(template,rpcFor(),collector,source);expect(pub.snapshot.finance.events).toEqual([]);expect(pub.snapshot.network.events).toEqual([]);expect(pub.snapshot.finance.stateSamples).toEqual([]);expect(pub.snapshot.network.stateSamples).toEqual([]);
 expect(pub.checkpoints.every(c=>c.fromBlock==='1000000000'&&c.toBlock==='1000000000'&&c.nextBlock==='1000000001')).toBe(true);expect(pub.collector.intervalMinutes).toBe(60);expect(pub.snapshot.snapshotId).not.toBe(template.snapshotId);expect(template.network.events.length).toBeGreaterThan(0);
});
it('rejects new-source identity mismatches rather than publishing a fabricated empty range',async()=>{
 const bad=()=>({requestsMade:0,async call(){return'0x1';}});await expect(freshPublication(template,bad,collector,source)).rejects.toMatchObject({code:'WRONG_CHAIN'});
});
