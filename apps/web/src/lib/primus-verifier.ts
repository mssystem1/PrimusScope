import {PrimusPageCoreTLS} from '@primuslabs/zktls-page-core-sdk';
// The SDK's published declaration imports a missing index.d; runtime exports are
// pinned and checked separately. The private boundary uses our strict schema.
import {encodeAttestation} from '@primuslabs/zktls-page-core-sdk/dist/utils';
import {utils} from 'ethers';
import {SDK_INFO,PageAttestationSchema,InspectionPolicySchema,MAX_ATTESTATION_BYTES,type Check,type InspectionResult,type InspectionPolicy} from './sdk-tools';

const check=(status:Check['status'],code:string):Check=>({status,code});
export function inspectAttestation(raw:string,policy:InspectionPolicy,now=Date.now()):InspectionResult{
  const start=performance.now(),pending=()=>check('not_checked','NOT_RUN');
  const result:InspectionResult={sdk:SDK_INFO,outcome:'unsupported',checkedAt:new Date(now).toISOString(),durationMs:0,sdkInvoked:false,errorCode:'UNSUPPORTED_FORMAT',
    checks:{format:pending(),signature:pending(),sdkSigner:pending(),recipient:pending(),request:pending(),context:pending(),freshness:pending()}};
  try{
    if(new TextEncoder().encode(raw).length>MAX_ATTESTATION_BYTES)throw new Error('FORMAT');
    const parsed=PageAttestationSchema.safeParse(JSON.parse(raw)),settings=InspectionPolicySchema.safeParse(policy);
    if(!parsed.success||!settings.success)throw new Error('FORMAT');
    const att=parsed.data,p=settings.data;
    result.checks.format=check('passed','SUPPORTED_SINGLE_SIGNATURE_SCHEMA');
    let recovered:string,matched:boolean;
    try{
      result.sdkInvoked=true;
      matched=PrimusPageCoreTLS.prototype.verifyAttestation(att);
      recovered=utils.recoverAddress(encodeAttestation(att),att.signatures[0]);result.checks.signature=check('passed','ECDSA_RECOVERY_SUCCEEDED');
    }
    catch{result.outcome='rejected';result.errorCode='SIGNATURE_REJECTED';result.checks.signature=check('failed','SIGNATURE_RECOVERY_FAILED');return result;}
    // The browser constructor starts node-discovery fetch/WebSocket work. Do not
    // construct/init it. This pinned method uses no instance state and is the
    // actual official SDK implementation, invoked in an offline CSP worker.
    if(matched!==(recovered.toLowerCase()===SDK_INFO.signer.toLowerCase()))throw new Error('SDK');
    result.checks.sdkSigner=check(matched?'passed':'failed',matched?'MATCHES_SDK_PIN':'DOES_NOT_MATCH_SDK_PIN');
    result.checks.recipient=p.recipient?check(att.recipient.toLowerCase()===p.recipient.toLowerCase()?'passed':'failed','EXPECTED_RECIPIENT_COMPARISON'):check('not_checked','NO_EXPECTED_RECIPIENT');
    const requestSpecified=Boolean(p.requestUrl||p.requestMethod);
    result.checks.request=requestSpecified?check((!p.requestUrl||att.request.url===p.requestUrl)&&(!p.requestMethod||att.request.method===p.requestMethod)?'passed':'failed','EXPECTED_REQUEST_FIELDS_COMPARISON'):check('not_checked','NO_EXPECTED_REQUEST');
    result.checks.context=p.additionParams?check(att.additionParams===p.additionParams?'passed':'failed','EXACT_ADDITION_PARAMS_COMPARISON'):check('not_checked','NO_EXPECTED_CONTEXT');
    if(p.timestampUnit!=='unspecified'){
      const stamp=BigInt(att.timestamp),milliseconds=p.timestampUnit==='seconds'?stamp*1000n:stamp,age=BigInt(now)-milliseconds;
      result.checks.freshness=age < -120000n?check('failed','TIMESTAMP_IN_FUTURE'):age>BigInt(p.maxAgeSeconds)*1000n?check('failed','OUTSIDE_SELECTED_MAX_AGE'):check('passed','WITHIN_SELECTED_AGE_WINDOW');
    }else result.checks.freshness=check('not_checked','TIMESTAMP_UNIT_NOT_SELECTED');
    const mismatch=[result.checks.recipient,result.checks.request,result.checks.context,result.checks.freshness].some(item=>item.status==='failed');
    result.outcome=matched&&!mismatch?'signer_matched':'rejected';result.errorCode=!matched?'SIGNER_MISMATCH':mismatch?'POLICY_MISMATCH':'NONE';
  }catch{
    if(result.checks.format.status==='passed'){result.outcome='error';result.errorCode='SDK_ERROR';}
    else{result.checks.format=check('unsupported','UNSUPPORTED_OR_MALFORMED_INPUT');result.outcome='unsupported';result.errorCode='UNSUPPORTED_FORMAT';}
  }
  finally{result.durationMs=Math.min(30000,Math.max(0,performance.now()-start));}
  return result;
}
