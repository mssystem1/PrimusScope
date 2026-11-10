import {afterEach,describe,expect,it,vi} from 'vitest';
import {PrimusPageCoreTLS} from '@primuslabs/zktls-page-core-sdk';
import {encodeAttestation} from '@primuslabs/zktls-page-core-sdk/dist/utils';
import fixture from '../fixtures/negative-attestation.json';
import {inspectAttestation} from './primus-verifier';
import {SDK_INFO,emptyInspectionPolicy,diagnosticFromResult,DiagnosticBatchSchema,MAX_ATTESTATION_BYTES} from './sdk-tools';

afterEach(()=>vi.restoreAllMocks());
describe('official SDK verifier boundary',()=>{
 it('runs the genuine SDK on a valid self-signed negative example without construction, traffic or logging',()=>{
  const method=vi.spyOn(PrimusPageCoreTLS.prototype,'verifyAttestation');
  const network=vi.spyOn(globalThis,'fetch'),logging=vi.spyOn(console,'log');
  const result=inspectAttestation(JSON.stringify(fixture),emptyInspectionPolicy);
  expect(method).toHaveBeenCalledOnce();expect(network).not.toHaveBeenCalled();expect(logging).not.toHaveBeenCalled();
  expect(result.sdkInvoked).toBe(true);expect(result.checks.format.status).toBe('passed');expect(result.checks.signature.status).toBe('passed');
  expect(result.checks.sdkSigner.status).toBe('failed');expect(result.outcome).toBe('rejected');expect(result.errorCode).toBe('SIGNER_MISMATCH');
  expect(result.checks.freshness.status).toBe('not_checked');expect(result.checks.context.status).toBe('not_checked');
  expect(result.sdk.package).toBe(SDK_INFO.package);
 });
 it.each(['not json','[]','{}',JSON.stringify({...fixture,responseResolve:fixture.reponseResolve}),JSON.stringify({...fixture,signatures:[]}),JSON.stringify({...fixture,signatures:[fixture.signatures[0],fixture.signatures[0]]}),JSON.stringify({...fixture,timestamp:Number.MAX_SAFE_INTEGER+1}),JSON.stringify({...fixture,timestamp:'18446744073709551616'}),'x'.repeat(MAX_ATTESTATION_BYTES+1)])('does not invoke the SDK for unsupported or oversized input',raw=>{
  const method=vi.spyOn(PrimusPageCoreTLS.prototype,'verifyAttestation');const result=inspectAttestation(raw,emptyInspectionPolicy);
  expect(result.outcome).toBe('unsupported');expect(result.sdkInvoked).toBe(false);expect(method).not.toHaveBeenCalled();
 });
 it('reports malformed curve signatures without echoing raw contents or SDK exceptions',()=>{
  const raw={...fixture,data:'DO_NOT_DISCLOSE_BODY',signatures:['0x'+'00'.repeat(64)+'1b']};const result=inspectAttestation(JSON.stringify(raw),emptyInspectionPolicy);
  expect(result.outcome).toBe('rejected');expect(result.checks.signature.status).toBe('failed');expect(JSON.stringify(result)).not.toContain('DO_NOT_DISCLOSE_BODY');
 });
 it('checks expected fields and selected age policy separately from a failed SDK signer check',()=>{
  const now=1762822800000;
  const matching={...emptyInspectionPolicy,recipient:fixture.recipient,requestUrl:fixture.request.url,requestMethod:'GET',additionParams:fixture.additionParams,timestampUnit:'seconds' as const,maxAgeSeconds:3600};
  const result=inspectAttestation(JSON.stringify(fixture),matching,now);
  for(const key of ['recipient','request','context','freshness'] as const)expect(result.checks[key].status).toBe('passed');
  expect(result.outcome).toBe('rejected');
  const wrong=inspectAttestation(JSON.stringify(fixture),{...matching,recipient:'0x2222222222222222222222222222222222222222',requestUrl:'https://wrong.invalid',additionParams:'wrong',maxAgeSeconds:10},now);
  for(const key of ['recipient','request','context','freshness'] as const)expect(wrong.checks[key].status).toBe('failed');
  expect(inspectAttestation(JSON.stringify({...fixture,timestamp:1762830000}),matching,now).checks.freshness.code).toBe('TIMESTAMP_IN_FUTURE');
  expect(inspectAttestation(JSON.stringify(fixture),{...matching,timestampUnit:'milliseconds'},now).checks.freshness.code).toBe('OUTSIDE_SELECTED_MAX_AGE');
 });
 it('does not accept a changed SDK trust decision inconsistent with recovered signer',()=>{
  vi.spyOn(PrimusPageCoreTLS.prototype,'verifyAttestation').mockReturnValue(true);
  const result=inspectAttestation(JSON.stringify(fixture),emptyInspectionPolicy);
  expect(result.outcome).toBe('error');expect(result.errorCode).toBe('SDK_ERROR');
 });
 it('documents that legacy packed fields and unsigned attestor metadata do not establish authorization',()=>{
  const a={...fixture,data:'one',attConditions:'two'},b={...fixture,data:'onet',attConditions:'wo'};
  expect(encodeAttestation(a)).toBe(encodeAttestation(b));
  expect(encodeAttestation({...fixture,attestors:[]})).toBe(encodeAttestation(fixture));
 });
 it('exports only the fixed diagnostic allowlist even if a result object is decorated with private values',()=>{
  const result=Object.assign(inspectAttestation(JSON.stringify(fixture),emptyInspectionPolicy),{raw:'PRIVATE_PROOF',url:'https://secret.invalid',signature:'PRIVATE_SIGNATURE',recipient:'PRIVATE_RECIPIENT',error:{message:'PRIVATE_ERROR'}});
  const event=diagnosticFromResult(result,true);expect(Object.keys(event)).toHaveLength(10);expect(event.isTest).toBe(true);
  expect(JSON.stringify(event)).not.toMatch(/PRIVATE_|secret\.invalid/);
  expect(DiagnosticBatchSchema.safeParse({events:[{...event,payload:'secret'}]}).success).toBe(false);
  expect(DiagnosticBatchSchema.safeParse({events:[{...event,sdk:{payload:'secret'}}]}).success).toBe(false);
 });
});
