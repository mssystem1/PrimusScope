import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerError } from './registry';

export interface Rpc {call(method:string,params:unknown[]):Promise<unknown>;readonly requestsMade:number;}
export type RpcLimits={maxRequests:number;maxSeconds:number;timeoutSeconds:number;maxResponseBytes:number;minIntervalMs:number};
const METHODS=new Set(['eth_chainId','eth_getBlockByNumber','eth_getLogs','eth_getCode','eth_getStorageAt','eth_getTransactionReceipt']);
export const DEFAULT_RPC_LIMITS:RpcLimits={maxRequests:100,maxSeconds:180,timeoutSeconds:10,maxResponseBytes:2_000_000,minIntervalMs:350};
export function numericRetryAfter(raw:string,status:number):number|undefined {
  if(Buffer.byteLength(raw)>65_536)return;
  let current=0;let values:string[]=[];
  for(const line of raw.split(/\r?\n/)){
    const match=line.match(/^HTTP\/\S+ (\d{3})(?:\s|$)/);
    if(match){current=Number(match[1]);values=[];continue;}
    const header=line.match(/^retry-after\s*:\s*(.*?)\s*$/i);if(header)values.push(header[1]);
  }
  if(current!==status||values.length!==1||!/^\d{1,6}$/.test(values[0])||Number(values[0])>86_400)return;
  return Number(values[0]);
}
export class CurlRpc implements Rpc {
  requestsMade=0;
  readonly trace:{method:string;outcome:string}[]=[];
  private readonly deadline:number;
  private lastStart=0;
  private readonly endpoint:string;
  constructor(endpoint:string,readonly limits:RpcLimits=DEFAULT_RPC_LIMITS){
    let valid=false;
    try{const url=new URL(endpoint);valid=url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!/[\x00-\x20\x7f]/.test(endpoint)&&Boolean(url.hostname);}catch{}
    if(!valid)throw new WorkerError('INVALID_ENDPOINT');
    if(!Number.isInteger(limits.maxRequests)||limits.maxRequests<1||limits.maxRequests>1000||!Number.isInteger(limits.maxSeconds)||limits.maxSeconds<1||limits.maxSeconds>600
      ||!Number.isInteger(limits.timeoutSeconds)||limits.timeoutSeconds<1||limits.timeoutSeconds>30||!Number.isInteger(limits.maxResponseBytes)||limits.maxResponseBytes<1||limits.maxResponseBytes>5_000_000
      ||!Number.isInteger(limits.minIntervalMs)||limits.minIntervalMs<0||limits.minIntervalMs>5000)throw new WorkerError('INVALID_LIMITS');
    this.endpoint=endpoint;this.deadline=Date.now()+limits.maxSeconds*1000;
  }
  async call(method:string,params:unknown[]):Promise<unknown>{
    const safeMethod=METHODS.has(method)?method:'rejected';
    try{const result=await this.request(method,params);if(this.trace.length<1000)this.trace.push({method:safeMethod,outcome:'ok'});return result;}
    catch(error){if(this.trace.length<1000)this.trace.push({method:safeMethod,outcome:error instanceof WorkerError?error.code:'RPC_TRANSPORT_ERROR'});throw error;}
  }
  private async request(method:string,params:unknown[]):Promise<unknown>{
    if(!METHODS.has(method)||!Array.isArray(params))throw new WorkerError('INVALID_RPC_METHOD');
    if(this.requestsMade>=this.limits.maxRequests)throw new WorkerError('REQUEST_BUDGET_EXHAUSTED');
    const wait=Math.max(0,this.lastStart+this.limits.minIntervalMs-Date.now());
    if(Date.now()+wait+this.limits.timeoutSeconds*1000+500>this.deadline)throw new WorkerError('RUN_DEADLINE_EXHAUSTED');
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
    this.lastStart=Date.now();const id=++this.requestsMade;
    const payload=JSON.stringify({jsonrpc:'2.0',id,method,params});
    if(Buffer.byteLength(payload)>100_000)throw new WorkerError('RPC_REQUEST_TOO_LARGE');
    const directory=await mkdtemp(join(tmpdir(),'primusscope-worker-rpc-'));
    try{
      const request=join(directory,'request.json'),response=join(directory,'response.json'),headers=join(directory,'headers.txt');
      await writeFile(request,payload,{mode:0o600});
      const args=['--disable','--silent','--show-error','--proto','=https','--request','POST','--header','Content-Type: application/json','--connect-timeout',String(Math.min(5,this.limits.timeoutSeconds)),
        '--max-time',String(this.limits.timeoutSeconds),'--max-filesize',String(this.limits.maxResponseBytes),'--data-binary','@'+request,'--output',response,'--dump-header',headers,'--write-out','%{http_code} %{http_connect}','--config','-'];
      const result=await new Promise<{code:number|null;status:string}>((resolve,reject)=>{
        const child=spawn('curl',args,{stdio:['pipe','pipe','pipe']});let status='';let settled=false;
        const timer=setTimeout(()=>{child.kill('SIGKILL');if(!settled){settled=true;reject(new WorkerError('REQUEST_TIMEOUT',true));}},this.limits.timeoutSeconds*1000+500);
        child.stdout.on('data',chunk=>{if(status.length<128)status+=String(chunk).slice(0,128-status.length);});
        child.stderr.on('data',()=>{}); // Do not retain endpoint/proxy diagnostics.
        child.on('error',()=>{clearTimeout(timer);if(!settled){settled=true;reject(new WorkerError('TRANSPORT_UNAVAILABLE'));}});
        child.on('close',code=>{clearTimeout(timer);if(!settled){settled=true;resolve({code,status});}});
        child.stdin.on('error',()=>{});
        child.stdin.end('url = "'+this.endpoint.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"\n');
      });
      const match=result.status.match(/^(\d{3}) (\d{3})$/);const status=Number(match?.[1]??0),connect=Number(match?.[2]??0);
      let retryAfterSeconds:number|undefined;
      try{if((await stat(headers)).size<=65_536)retryAfterSeconds=numericRetryAfter(await readFile(headers,'utf8'),status);}catch{}
      if(connect===403)throw new WorkerError('PROXY_TUNNEL_DENIED');
      if(result.code===28)throw new WorkerError('REQUEST_TIMEOUT',true);
      if(result.code===63)throw new WorkerError('RESPONSE_TOO_LARGE',true);
      if(result.code===51||result.code===60||result.code===77)throw new WorkerError('TLS_VERIFICATION_FAILED');
      if(status===429)throw new WorkerError('RATE_LIMITED',false,retryAfterSeconds);
      if(status===403){
        // Some free nodes report archive-capability restrictions using HTTP403
        // and a JSON-RPC error. Classify only the fixed capability code, never
        // retain or echo the provider's message or request arguments.
        try{
          if((await stat(response)).size<=this.limits.maxResponseBytes){
            const denied=JSON.parse(await readFile(response,'utf8'));
            if(denied?.jsonrpc==='2.0'&&denied.id===id&&denied.error&&typeof denied.error.code==='number'&&typeof denied.error.message==='string'&&/archive|historical/i.test(denied.error.message))throw new WorkerError('RPC_ARCHIVE_UNAVAILABLE');
          }
        }catch(error){if(error instanceof WorkerError)throw error;}
        throw new WorkerError('HTTP_FORBIDDEN');
      }
      if(status>=300&&status<400)throw new WorkerError('REDIRECT_REFUSED');
      if(status>=500)throw new WorkerError('HTTP_SERVER_ERROR');
      if(result.code!==0||status!==200)throw new WorkerError('RPC_TRANSPORT_ERROR');
      if((await stat(response)).size>this.limits.maxResponseBytes)throw new WorkerError('RESPONSE_TOO_LARGE',true);
      let parsed:Record<string,unknown>;
      try{parsed=JSON.parse(await readFile(response,'utf8'));}catch{throw new WorkerError('INVALID_RPC_RESPONSE');}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.jsonrpc!=='2.0'||parsed.id!==id||Object.hasOwn(parsed,'result')===Object.hasOwn(parsed,'error'))throw new WorkerError('INVALID_RPC_RESPONSE');
      if(Object.hasOwn(parsed,'error')){
        const error=parsed.error as Record<string,unknown>;
        if(!error||typeof error!=='object'||typeof error.code!=='number'||typeof error.message!=='string')throw new WorkerError('INVALID_RPC_RESPONSE');
        const message=error.message.toLowerCase();
        if(/rate limit|too many requests|quota|credits?|daily limit|monthly limit|request limit/.test(message))throw new WorkerError('RATE_LIMITED',false,retryAfterSeconds);
        if(/block range|too many results|response size|query returned more|range too large/.test(message))throw new WorkerError('RPC_RANGE_LIMIT',true);
        throw new WorkerError('RPC_ERROR');
      }
      return parsed.result;
    }catch(error){if(error instanceof WorkerError)throw error;throw new WorkerError('RPC_TRANSPORT_ERROR');}
    finally{await rm(directory,{recursive:true,force:true});}
  }
}
