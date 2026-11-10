import {afterEach,expect,it,vi} from 'vitest';
import fixture from '../fixtures/negative-attestation.json';
import {createMeasuredPrimusVerifier} from '../../../../examples/primus-verifier-diagnostics';
afterEach(()=>vi.restoreAllMocks());
it('runs the genuine verifier with external reporting disabled by default',()=>{
 const network=vi.spyOn(globalThis,'fetch');expect(createMeasuredPrimusVerifier()(fixture)).toBe(false);expect(network).not.toHaveBeenCalled();
});
it('measures actual SDK rejection and sends only the event allowlist when explicitly enabled',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 const verify=createMeasuredPrimusVerifier({enabled:true,appId:'11111111-1111-4111-8111-111111111111',ingestToken:'x'.repeat(43),testEvents:true});
 expect(verify({...fixture,data:'PRIVATE_SOURCE_BODY',request:{...fixture.request,header:'PRIVATE_COOKIE'}})).toBe(false);await Promise.resolve();
 const [url,request]=network.mock.calls[0]!;expect(String(url)).not.toContain('PRIVATE_');
 expect(String(request?.body)).not.toMatch(/PRIVATE_|signature|recipient|https:\/\/example/);
 const parsed=JSON.parse(String(request?.body));expect(Object.keys(parsed.events[0])).toHaveLength(10);expect(parsed.events[0]).toMatchObject({sdkInvoked:true,isTest:true,outcome:'rejected',errorCode:'SIGNER_MISMATCH'});
 expect(request?.credentials).toBe('omit');expect(request?.referrerPolicy).toBe('no-referrer');
});
it('does not forward SDK exceptions or make successful telemetry a condition of the application result',async()=>{
 vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));
 const verify=createMeasuredPrimusVerifier({enabled:true,appId:'11111111-1111-4111-8111-111111111111',ingestToken:'x'.repeat(43)});
 expect(()=>verify({...fixture,signatures:['PRIVATE_SIGNATURE']})).toThrow('PRIMUS_LOCAL_SIGNATURE_CHECK_FAILED');await Promise.resolve();
});
