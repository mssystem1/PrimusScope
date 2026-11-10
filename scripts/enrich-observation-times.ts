import { readFileSync, writeFileSync } from 'node:fs';
import { neonClient, PostgresPublicationStore } from '@primusscope/storage/postgres';
import { StorageError } from '@primusscope/storage';
import { CurlRpc, DEFAULT_RPC_LIMITS } from '../apps/worker/src/rpc';
import { enrichObservationTimes } from '../apps/worker/src/enrich-times';
import { sourceFor, WorkerError } from '../apps/worker/src/registry';
import type { HostedPublication } from '@primusscope/storage/publication';

async function main(){
  const mode=process.argv[2];
  if(mode==='recorded'){
    const snapshot=JSON.parse(readFileSync('data/observations/current.json','utf8'));
    // Recorded anchors are the same reviewed seed boundaries used by the worker.
    const publication={snapshot,checkpoints:(['finance','network'] as const).map(domain=>({domain,
      toBlock:snapshot[domain].coverage.toBlock,toTime:snapshot[domain].coverage.toTime,
      blockHash:sourceFor(domain,snapshot).seedHash,quarantined:false}))} as HostedPublication;
    const result=await enrichObservationTimes(publication,domain=>new CurlRpc(sourceFor(domain,snapshot).endpoint,
      {...DEFAULT_RPC_LIMITS,maxRequests:300,maxSeconds:240}));
    writeFileSync('data/observations/current.json',JSON.stringify(result.snapshot,null,2)+'\n');
    console.log(JSON.stringify({mode,reports:result.reports,snapshotId:result.snapshot.snapshotId}));return;
  }
  if(mode!=='hosted')throw new StorageError('INVALID_COMMAND');
  process.loadEnvFile('.local/hosted-credentials.env');
  const store=new PostgresPublicationStore(neonClient(process.env.WORKER_DATABASE_URL!));
  const token=await store.acquireLease('timestamp-enrichment');
  if(!token){console.log(JSON.stringify({outcome:'busy'}));return;}
  try{
    const state=await store.read();if(!state)throw new StorageError('NOT_INITIALIZED');
    const result=await enrichObservationTimes(state.publication,domain=>new CurlRpc(sourceFor(domain,state.publication.snapshot).endpoint,
      {...DEFAULT_RPC_LIMITS,maxRequests:300,maxSeconds:240}));
    await store.renewLease(token);
    const revision=result.reports.length?await store.publish(token,state.revision,{...state.publication,snapshot:result.snapshot}):state.revision;
    console.log(JSON.stringify({outcome:'completed',revision,reports:result.reports}));
  }finally{await store.releaseLease(token);}
}
main().catch(error=>{console.log(JSON.stringify({outcome:'failed',code:error instanceof WorkerError||error instanceof StorageError?error.code:'ENRICHMENT_FAILED'}));process.exitCode=1;});
