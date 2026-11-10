import {inspectAttestation} from '../lib/primus-verifier';
import {MAX_ATTESTATION_BYTES,InspectionPolicySchema} from '../lib/sdk-tools';

// No input, exception, identifier or secret is printed or sent off-device.
for(const method of ['log','warn','error','debug','info'] as const)console[method]=()=>{};
globalThis.fetch=()=>Promise.reject(new Error('OFFLINE_WORKER'));
self.addEventListener('message',event=>{
  const message=event.data;
  if(!message||typeof message.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(message.id)||typeof message.raw!=='string'||message.raw.length>MAX_ATTESTATION_BYTES||!InspectionPolicySchema.safeParse(message.policy).success){self.postMessage({id:message?.id,failed:true});return;}
  const result=inspectAttestation(message.raw,message.policy);
  self.postMessage({id:message.id,result});
});
self.postMessage({ready:true});
