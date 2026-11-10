// Install/pin @primuslabs/zktls-page-core-sdk@0.2.1 in the integrating app.
import {PrimusPageCoreTLS} from '@primuslabs/zktls-page-core-sdk';

type Configuration={enabled?:boolean;appId?:string;ingestToken?:string;testEvents?:boolean};
/** Actual SDK verifier + optional, minimized client reports. No payload logging. */
export function createMeasuredPrimusVerifier(configuration:Configuration={}){
 if(configuration.enabled&&(!/^[a-f0-9-]{36}$/i.test(configuration.appId??'')||!/^[a-zA-Z0-9_-]{43}$/.test(configuration.ingestToken??'')))throw new Error('INVALID_DIAGNOSTICS_CONFIGURATION');
 return function matchesPinnedSdkSigner(attestation:unknown):boolean{
  const started=performance.now();let matched=false,failed=false;
  try{
   // Avoid browser construction: this version's constructor discovers nodes.
   // The pinned official verification method uses no instance state.
   matched=PrimusPageCoreTLS.prototype.verifyAttestation(attestation);
   return matched;
  }catch{failed=true;throw new Error('PRIMUS_LOCAL_SIGNATURE_CHECK_FAILED');}
  finally{
   if(configuration.enabled){
    const event={eventId:crypto.randomUUID(),sdk:'@primuslabs/zktls-page-core-sdk',version:'0.2.1',operation:'verifyAttestation',
     durationMs:Math.round(Math.min(30000,Math.max(0,performance.now()-started))*100)/100,
     outcome:failed?'error':matched?'signer_matched':'rejected',sdkInvoked:true,isTest:configuration.testEvents===true,
     errorCode:failed?'SDK_ERROR':matched?'NONE':'SIGNER_MISMATCH',runtime:'browser'};
    // The SDK result never depends on successful diagnostic delivery. A failed
    // delivery stays an unobserved sample; no fabricated retry event is added.
    void fetch('https://primus-scope.vercel.app/api/v1/developer/apps/'+configuration.appId+'/events',{
     method:'POST',credentials:'omit',referrerPolicy:'no-referrer',
     headers:{'Content-Type':'application/json',Authorization:'Bearer '+configuration.ingestToken},
     body:JSON.stringify({events:[event]}),
    }).catch(()=>{});
   }
  }
 };
}
