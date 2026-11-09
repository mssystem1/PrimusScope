import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SQLiteStore, StorageError, defaultDatabasePath } from '@primusscope/storage';
import recorded from '../../../data/observations/current.json';
import { ObservationSetSchema } from '@primusscope/api-schema';
import { DEFAULT_SCAN_LIMITS, runOnce, seedAnchors } from './indexer';
import { CurlRpc, DEFAULT_RPC_LIMITS } from './rpc';
import { EVIDENCE_POLICY, WorkerError, registeredEndpoint, type Domain } from './registry';

const root=fileURLToPath(new URL('../../../',import.meta.url));
type Options={command:'init'|'once'|'status';domain:'finance'|'network'|'all';db:string;maxBlocks:number;chunkSize:number;maxRequests:number;maxSeconds:number};
export function parseOptions(args:string[]):Options {
  const command=args.shift();if(command!=='init'&&command!=='once'&&command!=='status')throw new WorkerError('INVALID_COMMAND');
  const values=new Map<string,string>();const allowed=new Set(['domain','db','max-blocks','chunk-size','max-requests','max-seconds']);
  while(args.length){const option=args.shift();const value=args.shift();if(!option?.startsWith('--')||!allowed.has(option.slice(2))||value===undefined||value.startsWith('--')||values.has(option.slice(2)))throw new WorkerError('INVALID_OPTIONS');values.set(option.slice(2),value);}
  const domain=values.get('domain')??'all';if(!['all','finance','network'].includes(domain))throw new WorkerError('INVALID_OPTIONS');
  function integer(key:string,fallback:number,max:number){const value=values.get(key);if(value===undefined)return fallback;if(!/^[1-9][0-9]*$/.test(value)||value.length>6||Number(value)>max)throw new WorkerError('INVALID_OPTIONS');return Number(value);}
  return {command,domain:domain as Options['domain'],db:resolve(values.get('db')??process.env.PRIMUSSCOPE_DB_PATH??defaultDatabasePath(root)),
    maxBlocks:integer('max-blocks',DEFAULT_SCAN_LIMITS.maxBlocks,10_000),chunkSize:integer('chunk-size',DEFAULT_SCAN_LIMITS.chunkSize,10_000),
    maxRequests:integer('max-requests',DEFAULT_RPC_LIMITS.maxRequests,1000),maxSeconds:integer('max-seconds',DEFAULT_RPC_LIMITS.maxSeconds,600)};
}
export async function main(args=process.argv.slice(2)):Promise<void>{
  const options=parseOptions([...args]);const snapshot=ObservationSetSchema.parse(recorded);
  const store=new SQLiteStore(options.db,options.command==='status'?{readOnly:true}:{});
  try{
    if(options.command==='status'){process.stdout.write(JSON.stringify(store.getStatus(),null,2)+'\n');return;}
    const clients=new Map<Domain,CurlRpc>();
    const rpcFor=(domain:Domain)=>{
      const client=new CurlRpc(registeredEndpoint(domain,snapshot,domain==='finance'?process.env.BNB_RPC_URL:process.env.BASE_RPC_URL),
        {...DEFAULT_RPC_LIMITS,maxRequests:options.maxRequests,maxSeconds:options.maxSeconds});
      clients.set(domain,client);return client;
    };
    if(options.command==='init'){
      const before=store.getStatus();
      if(before.publication!=='empty'){process.stdout.write(JSON.stringify({outcome:'already_initialized',status:before},null,2)+'\n');return;}
      let anchors;
      try{anchors=await seedAnchors(snapshot,rpcFor);}
      catch(error){
        const code=error instanceof WorkerError?error.code:'INDEXER_FAILED';
        process.stdout.write(JSON.stringify({outcome:'failed',code,diagnostics:[...clients].map(([domain,client])=>({domain,rpcRequests:client.requestsMade,trace:client.trace}))},null,2)+'\n');process.exitCode=1;return;
      }
      store.initialize(snapshot,anchors);
      process.stdout.write(JSON.stringify({outcome:'initialized',evidencePolicy:EVIDENCE_POLICY,status:store.getStatus()},null,2)+'\n');return;
    }
    if(store.getStatus().publication==='empty')throw new WorkerError('STORE_NOT_INITIALIZED');
    const domains=options.domain==='all'?(['finance','network']as const):[options.domain];
    const reports=[];
    for(const domain of domains)reports.push(await runOnce(store,rpcFor(domain),domain,{...DEFAULT_SCAN_LIMITS,maxBlocks:options.maxBlocks,chunkSize:options.chunkSize}));
    process.stdout.write(JSON.stringify({reports,status:store.getStatus()},null,2)+'\n');
    if(reports.some(report=>report.outcome==='failed'))process.exitCode=1;
  }finally{store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{
    const code=error instanceof WorkerError||error instanceof StorageError?error.code:'INDEXER_FAILED';
    process.stdout.write(JSON.stringify({outcome:'failed',code})+'\n');process.exitCode=1;
  });
}
