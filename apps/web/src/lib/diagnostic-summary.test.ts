import {expect,it} from 'vitest';
import {SDK_INFO,type DiagnosticRecord} from './sdk-tools';
import {summarizeDiagnostics} from './diagnostic-summary';
const record=(durationMs:number,isTest=false,sdkInvoked=true):DiagnosticRecord=>({eventId:crypto.randomUUID(),sdk:SDK_INFO.package,version:SDK_INFO.version,operation:'verifyAttestation',durationMs,outcome:'rejected',errorCode:'SIGNER_MISMATCH',runtime:'browser',sdkInvoked,isTest,receivedAt:'2026-11-10T19:00:00.000Z'});
it('keeps examples separate and suppresses percentiles when fewer than five real SDK calls were observed',()=>{
 const rows=[record(2),record(4),record(1,true),record(100,false,false)];const result=summarizeDiagnostics(rows);
 expect(result.attempts).toBe(3);expect(result.sdkCalls).toBe(2);expect(result.testEvents).toBe(1);expect(result.p50Ms).toBeNull();expect(result.p90Ms).toBeNull();
 expect(summarizeDiagnostics(rows,true).attempts).toBe(4);
});
it('computes nearest-rank device durations on eligible invocations, with outcome counts rather than proof-success rates',()=>{
 const result=summarizeDiagnostics([2,4,6,8,10].map(ms=>record(ms)));
 expect(result.p50Ms).toBe(6);expect(result.p90Ms).toBe(10);expect(result.outcomes.find(row=>row.label==='rejected')?.count).toBe(5);
 expect(result.versions).toEqual([{version:'0.2.1',count:5,sdkCalls:5}]);
});
