import manifest from './sdk-worker-manifest.json';
import type {InspectionPolicy,InspectionResult,SDKProfile} from './sdk-tools';

/** Only the Worker receives raw input. Only bounded result enums leave it. */
export function runInspection(raw:string,policy:InspectionPolicy,signal:AbortSignal,profile:SDKProfile='page'):Promise<InspectionResult>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('CANCELLED'));return;}
    if(typeof Worker==='undefined'){reject(new Error('WORKER_UNAVAILABLE'));return;}
    const worker=new Worker(profile==='core'?manifest.core.path:manifest.path,{name:'primus-local-signature-check'}),id=crypto.randomUUID();
    let done=false;
    const finish=(code?:string,result?:InspectionResult)=>{
      if(done)return;done=true;clearTimeout(timeout);signal.removeEventListener('abort',cancel);worker.terminate();
      if(code)reject(new Error(code));else resolve(result!);
    };
    const cancel=()=>finish('CANCELLED');
    const timeout=setTimeout(()=>finish('TIMEOUT'),15000);
    signal.addEventListener('abort',cancel,{once:true});
    worker.addEventListener('error',event=>{event.preventDefault();finish('SDK_ERROR');});
    worker.addEventListener('message',event=>{
      if(event.data?.ready){worker.postMessage({id,raw,policy,profile});return;}
      if(event.data?.id!==id)return;
      if(event.data.failed)finish('INVALID_INPUT');else finish(undefined,event.data.result);
    });
  });
}
