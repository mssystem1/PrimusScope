import {expect,it} from 'vitest';
import {ObservationSetSchema} from '@primusscope/api-schema';
import type {HostedPublication} from '@primusscope/storage/publication';
import source from '../../../data/observations/current.json';
import {enrichObservationTimes} from './enrich-times';
import {sourceFor} from './registry';

function fixture(){
  const snapshot=ObservationSetSchema.parse(source);snapshot.network.events[0]!.timestamp=null;
  return {snapshot,checkpoints:(['finance','network'] as const).map(domain=>({domain,toBlock:snapshot[domain].coverage.toBlock,
    toTime:snapshot[domain].coverage.toTime,blockHash:sourceFor(domain,snapshot).seedHash,quarantined:false}))} as HostedPublication;
}
it('enriches only the missing time against its retained block hash without freshening collection time',async()=>{
  const p=fixture(),event=p.snapshot.network.events[0]!;
  const result=await enrichObservationTimes(p,domain=>({requestsMade:0,async call(method,params){
    if(method==='eth_chainId')return domain==='network'?'0x2105':'0x38';
    const block=BigInt(String(params[0])),checkpoint=p.checkpoints.find(c=>c.domain===domain)!;
    return {number:'0x'+block.toString(16),hash:block===BigInt(checkpoint.toBlock)?checkpoint.blockHash:event.blockHash,
      parentHash:'0x'+'00'.repeat(32),timestamp:'0x'+BigInt(Date.parse(block===BigInt(checkpoint.toBlock)?checkpoint.toTime:source.network.events[0]!.timestamp!)/1000).toString(16)};
  }}));
  expect(result.snapshot.network.events[0]!.timestamp).toBe(source.network.events[0]!.timestamp);
  expect(result.snapshot.network.coverage.observedAt).toBe(p.snapshot.network.coverage.observedAt);
  expect(result.snapshot.snapshotId).not.toBe(p.snapshot.snapshotId);expect(p.snapshot.network.events[0]!.timestamp).toBeNull();
});
it('refuses a different block hash before a changed publication can be returned',async()=>{
  const p=fixture();
  await expect(enrichObservationTimes(p,()=>({requestsMade:0,async call(method){
    if(method==='eth_chainId')return '0x2105';
    return {number:'0x'+BigInt(p.snapshot.network.coverage.toBlock).toString(16),hash:'0x'+'ff'.repeat(32),
      parentHash:'0x'+'00'.repeat(32),timestamp:'0x'+BigInt(Date.parse(p.snapshot.network.coverage.toTime)/1000).toString(16)};
  }}))).rejects.toMatchObject({code:'CHECKPOINT_HASH_CHANGED'});
});
