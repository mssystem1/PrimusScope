import{WatchBaselineSchema,type WatchBaseline,type WatchObservation}from'./workspace-schema';
import{BASELINE_STORAGE}from'./public-workspace';
export function readBaselines(ids:string[]):Record<string,WatchBaseline>{try{const text=localStorage.getItem(BASELINE_STORAGE)??'{}';if(text.length>200000)return{};const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return{};return Object.fromEntries(ids.flatMap(id=>{const entry=WatchBaselineSchema.safeParse(parsed[id]);return entry.success&&entry.data.observation.id===id?[[id,entry.data]]:[];}));}catch{return{};}}
export function writeBaselines(value:Record<string,WatchBaseline>){localStorage.setItem(BASELINE_STORAGE,JSON.stringify(value));}
export function compareSaved(current:WatchObservation,baseline?:WatchBaseline){
 if(current.availability!=='available')return{code:'unavailable',title:'Observation unavailable',detail:current.reason==='NOT_FOUND'?'Not found in the current covered scope. This does not mean the object was deleted.':current.reason==='INCOMPLETE_COVERAGE'?'Source coverage is incomplete; change comparisons are paused.':'This saved route is not supported for change tracking.'};
 if(!baseline)return{code:'new',title:'Tracking started',detail:'The first successful check establishes a local baseline.'};
 const old=baseline.observation;
 if(old.scopeKey!==current.scopeKey||old.href!==current.href)return{code:'scope_changed',title:'Coverage or source scope changed',detail:'A changed start boundary, registry, or serving mode needs a new review baseline. No growth delta is shown.'};
 if(current.coverage&&old.coverage&&(BigInt(current.coverage.toBlock)<BigInt(old.coverage.toBlock))||current.sourceAsOf&&old.sourceAsOf&&Date.parse(current.sourceAsOf)<Date.parse(old.sourceAsOf)||current.stateSampleBlock&&old.stateSampleBlock&&BigInt(current.stateSampleBlock)<BigInt(old.stateSampleBlock))return{code:'revised',title:'Source observations moved backward',detail:'Review the evidence before replacing the baseline; this is not a negative adoption trend.'};
 if(current.contentHash!==old.contentHash){
  if(current.kind==='view')return{code:'source_updated',title:'Saved view source updated',detail:'Source coverage or strategy observations advanced. Open the saved view for filter-specific analytics; this is not a measured activity increase.'};
  const changes:string[]=[];if(current.eventCount!==old.eventCount&&current.eventCount!==null&&old.eventCount!==null){const delta=current.eventCount-old.eventCount;changes.push('Recorded event count '+(delta>0?'+':'')+delta+'.');}if(current.state!==old.state)changes.push('Observed state changed from '+(old.state??'not sampled')+' to '+(current.state??'not sampled')+'.');
  return{code:'changed',title:'Public observations changed',detail:changes.join(' ')||'The observed event set was revised. Inspect the source timeline.'};
 }
 return{code:'unchanged',title:'No observed object changes',detail:current.coverage?.toBlock!==old.coverage?.toBlock?'Coverage advanced without a changed event set or state for this object.':'The same event set and state are still observed.'};
}
