import { createHash } from 'node:crypto';
import { ObservationSetSchema, type ObservationSet } from '@primusscope/api-schema';
import type { HostedPublication } from '@primusscope/storage/publication';
import type { Rpc } from './rpc';
import { header, hexQuantity, WorkerError, type Domain } from './registry';

/** Reconcile missing calendar times against the exact retained public block hashes. */
export async function enrichObservationTimes(publication: HostedPublication, rpcFor: (domain: Domain) => Rpc) {
  const snapshot = ObservationSetSchema.parse(publication.snapshot);
  const reports: { domain: Domain; eventsUpdated: number; blockReads: number }[] = [];
  for (const domain of ['finance','network'] as const) {
    const data=snapshot[domain], missing=data.events.filter(event=>event.timestamp===null);
    if(!missing.length && data.coverage.fromTime!==null) continue;
    const rpc=rpcFor(domain), checkpoint=publication.checkpoints.find(c=>c.domain===domain)!;
    if(checkpoint.quarantined) throw new WorkerError('SOURCE_QUARANTINED');
    if(hexQuantity(await rpc.call('eth_chainId',[]))!==BigInt(data.chainId))throw new WorkerError('WRONG_CHAIN');
    const get=async(block:string)=>header(await rpc.call('eth_getBlockByNumber',['0x'+BigInt(block).toString(16),false]),BigInt(block));
    const end=await get(checkpoint.toBlock);
    if(end.hash!==checkpoint.blockHash || end.time!==checkpoint.toTime)throw new WorkerError('CHECKPOINT_HASH_CHANGED');
    const blocks=[...new Set(missing.map(event=>event.blockNumber))];
    if(blocks.length>300)throw new WorkerError('REQUEST_BUDGET_EXHAUSTED');
    for(const block of blocks){
      const observed=await get(block), events=missing.filter(event=>event.blockNumber===block);
      if(events.some(event=>event.blockHash!==observed.hash))throw new WorkerError('BLOCK_HASH_MISMATCH');
      for(const event of events)event.timestamp=observed.time;
    }
    if(data.coverage.fromTime===null)data.coverage.fromTime=(await get(data.coverage.fromBlock)).time;
    if((await get(checkpoint.toBlock)).hash!==end.hash)throw new WorkerError('CHECKPOINT_HASH_CHANGED');
    reports.push({domain,eventsUpdated:missing.length,blockReads:blocks.length});
  }
  if(reports.length){
    const {snapshotId:_old,generatedAt:_generated,...core}=snapshot;
    snapshot.snapshotId=createHash('sha256').update(JSON.stringify({revision:'calendar-times-v1',observation:core})).digest('hex');
    snapshot.generatedAt=new Date().toISOString();
  }
  return {snapshot:ObservationSetSchema.parse(snapshot),reports};
}
