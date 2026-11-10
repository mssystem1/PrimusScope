import type {DiagnosticRecord} from '@primusscope/api-schema/sdk-diagnostics';
export function summarizeDiagnostics(records:DiagnosticRecord[],includeTests=false){
 const selected=records.filter(event=>includeTests||!event.isTest),calls=selected.filter(event=>event.sdkInvoked);
 const durations=calls.map(event=>event.durationMs).sort((a,b)=>a-b);
 const percentile=(p:number)=>durations.length<5?null:durations[Math.max(0,Math.ceil(durations.length*p)-1)]!;
 const kinds=['signer_matched','rejected','unsupported','error','cancelled'] as const;
 const outcomes=kinds.map(outcome=>({label:outcome.replaceAll('_',' '),count:selected.filter(event=>event.outcome===outcome).length}));
 const versions=[...new Set(selected.map(event=>event.version))].map(version=>({version,count:selected.filter(event=>event.version===version).length,sdkCalls:calls.filter(event=>event.version===version).length}));
 const days=new Map<string,number>();for(const event of selected){const day=event.receivedAt.slice(0,10);days.set(day,(days.get(day)??0)+1);}
 return {attempts:selected.length,sdkCalls:calls.length,testEvents:records.filter(event=>event.isTest).length,p50Ms:percentile(.5),p90Ms:percentile(.9),outcomes,versions,days:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,count])=>({label:day,count}))};
}
