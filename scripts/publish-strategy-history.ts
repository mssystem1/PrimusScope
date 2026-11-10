/** Publish independently harvested public flow history without moving event checkpoints. */
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FinanceStrategySchema} from '../packages/api-schema/src/index';
import {mergeStrategyFlowHistory} from '../packages/data/src/strategy-analytics';
import {PostgresPublicationStore,neonClient} from '../packages/storage/src/postgres';
import {SQLiteStore} from '../packages/storage/src/index';

async function main(){
const dryRun=process.argv.slice(2).includes('--dry-run');
if(process.argv.slice(2).some(arg=>arg!=='--dry-run'))throw new Error('Use only --dry-run, or no arguments to publish.');
const historical=FinanceStrategySchema.parse(JSON.parse(await readFile(new URL('../data/strategy/unitas-history.json',import.meta.url),'utf8')));
if(!historical.flowCoverage?.complete||(BigInt(historical.flowCoverage.fromBlock)>BigInt(historical.samples[0]!.blockNumber)||BigInt(historical.flowCoverage.toBlock)<BigInt(historical.samples.at(-1)!.blockNumber)))throw new Error('FULL_STOCK_PERIOD_FLOW_HISTORY_REQUIRED');
const connection=process.env.WORKER_DATABASE_URL;
if(!connection)throw new Error('WORKER_DATABASE_URL_REQUIRED');
const store=new PostgresPublicationStore(neonClient(connection));
const token=await store.acquireLease('public-flow-history');
if(!token)throw new Error('COLLECTOR_BUSY_RETRY_AFTER_CURRENT_JOB');
let directory:string|undefined,local:SQLiteStore|undefined;
try{
  const current=await store.read();if(!current)throw new Error('PUBLICATION_REQUIRED');
  if(current.publication.checkpoints.some(checkpoint=>checkpoint.quarantined))throw new Error('PUBLICATION_QUARANTINED');
  const previous=current.publication.snapshot.finance.strategy;
  if(previous&&['proxyAddress','vaultAddress','assetAddress'].some(key=>previous[key as keyof typeof previous]!==historical[key as keyof typeof historical]))throw new Error('STRATEGY_IDENTITY_MISMATCH');
  const merged=FinanceStrategySchema.parse({...historical,...previous,...mergeStrategyFlowHistory(historical,previous??historical)});
  const before={snapshotId:current.publication.snapshot.snapshotId,revision:current.revision,flowCount:previous?.flows.length??0,coverage:previous?.flowCoverage??null};
  let revision=current.revision;
  if(!dryRun){
    directory=await mkdtemp(join(tmpdir(),'primusscope-public-history-'));
    local=new SQLiteStore(join(directory,'history.sqlite'));local.restorePublication(current.publication);
    const lease=local.acquireLease('finance','public-history',120000);if(!lease)throw new Error('LOCAL_LEASE_BUSY');
    try{local.recordStrategy(lease.token,merged);}finally{local.releaseLease(lease.token);}
    await store.renewLease(token);
    const publication=local.exportPublication(current.publication.collector);
    for(const domain of ['finance','network'] as const)if(publication.checkpoints.find(c=>c.domain===domain)!.toBlock!==current.publication.checkpoints.find(c=>c.domain===domain)!.toBlock)throw new Error('CHECKPOINT_CHANGED');
    revision=await store.publish(token,current.revision,publication);
  }
  console.log(JSON.stringify({outcome:dryRun?'validated_dry_run':'published',before,revision,flowCount:merged.flows.length,coverage:merged.flowCoverage,eventCheckpointsPreserved:true}));
}finally{
  local?.close();if(directory)await rm(directory,{recursive:true,force:true});
  await store.releaseLease(token);
}

}
main().catch(error=>{const message=error instanceof Error?error.message:'';console.error(JSON.stringify({outcome:'failed',code:/^[A-Z_]{3,80}$/.test(message)?message:'HISTORY_PUBLICATION_FAILED'}));process.exitCode=1;});
