'use client';
import{useEffect,useRef,useState}from'react';
import Link from'next/link';
import{RefreshCw}from'lucide-react';
import{readSaved,WORKSPACE_EVENT,type SavedItem}from'../lib/public-workspace';
import{WatchResponseSchema,type WatchObservation,type WatchBaseline}from'../lib/workspace-schema';
import{readBaselines,writeBaselines,compareSaved}from'../lib/workspace-tracking';
export function SavedChanges({items}:{items:SavedItem[]}){
 const[observations,setObservations]=useState<WatchObservation[]>([]),[baselines,setBaselines]=useState<Record<string,WatchBaseline>>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[checkedAt,setCheckedAt]=useState('');
 const abort=useRef<AbortController|null>(null),sequence=useRef(0);
 const signature=JSON.stringify(items.map(({id,href})=>({id,href})));
 async function check(){
  abort.current?.abort();const controller=new AbortController(),generation=++sequence.current;abort.current=controller;setBusy(true);setMessage('');const timeout=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch('/api/v1/workspace/check',{method:'POST',cache:'no-store',credentials:'omit',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({items:items.map(({id,href})=>({id,href}))})});if(!response.ok)throw new Error();
   const data=WatchResponseSchema.parse(await response.json());if(generation!==sequence.current)return;
   if(data.items.length!==items.length||data.items.some((entry,index)=>entry.id!==items[index]?.id||entry.href!==items[index]?.href))throw new Error();
   setObservations(data.items);setCheckedAt(data.checkedAt);const saved=readBaselines(items.map(i=>i.id)),next={...saved};let changed=false;
   for(const observation of data.items)if(!next[observation.id]&&observation.availability==='available'){next[observation.id]={reviewedAt:data.checkedAt,observation};changed=true;}
   if(changed){try{writeBaselines(next);setMessage('Review baseline recorded in this browser. Future checks compare with it.');}catch{setBaselines(saved);setMessage('Browser storage is unavailable. A persistent review baseline could not be saved.');return;}}
   setBaselines(next);
  }catch{if(generation===sequence.current)setMessage('The update check could not finish. Your saved items and review baselines were kept. Try again.');}
  finally{clearTimeout(timeout);if(generation===sequence.current)setBusy(false);}
 }
 useEffect(()=>{setObservations([]);setCheckedAt('');setBaselines(readBaselines(items.map(i=>i.id)));if(items.length)void check();return()=>{sequence.current++;abort.current?.abort();};},[signature]);
 function reviewed(observation:WatchObservation){try{const next={...readBaselines(items.map(i=>i.id)),[observation.id]:{reviewedAt:new Date().toISOString(),observation}};writeBaselines(next);setBaselines(next);setMessage('Review baseline updated. Other saved objects keep their existing baselines.');}catch{setMessage('Browser storage is unavailable. The review baseline was not updated.');}}
 return <section className="saved-changes" aria-label="Saved public object changes"><div className="panel-heading"><div><h2>What changed in your saved objects</h2><p>Compared with your last review in this browser. Checks use the stored public index.</p></div><button className="button button-secondary" disabled={busy} onClick={()=>void check()}><RefreshCw size={15}/>{busy?'Checking…':'Check saved objects'}</button></div>
  <p className="muted small">{checkedAt?'Last checked '+new Date(checkedAt).toLocaleString()+' · device time.':'Checking stored observations…'} Saved views track source updates; open them for filtered analytics. These checks do not run in the background.</p>
  {observations.map(observation=>{const baseline=baselines[observation.id],change=compareSaved(observation,baseline),item=items.find(i=>i.id===observation.id);return <article className="saved-change-card" key={observation.id} data-change={change.code}><div><strong>{item?.title}</strong><span className={'pill '+(['changed','source_updated','scope_changed','revised'].includes(change.code)?'teal':'subtle')}>{change.title}</span></div><p>{change.detail}</p>{observation.kind!=='view'&&observation.availability==='available'&&<p className="muted small">{observation.eventCount} recorded events{observation.state?' · '+observation.state:''}{observation.stateSampleBlock?' · native sample at block '+observation.stateSampleBlock:''}.</p>}
   {baseline&&<small>Review baseline: {new Date(baseline.reviewedAt).toLocaleString()} · device time.</small>}{observation.coverage&&<small>Source blocks {observation.coverage.fromBlock}–{observation.coverage.toBlock}{observation.sourceAsOf?' · source as of '+observation.sourceAsOf.replace('T',' ').replace('.000Z',' UTC'):''}.</small>}
   <div className="button-row"><Link className="text-link" href={observation.href}>Inspect saved object →</Link>{observation.availability==='available'&&<button className="button button-secondary button-small" disabled={busy} onClick={()=>reviewed(observation)}>Mark as reviewed</button>}</div></article>;})}
  <p className="muted small" role="status">{message}</p>
 </section>;
}
export function OverviewSavedChanges(){const[items,setItems]=useState<SavedItem[]>([]);useEffect(()=>{const sync=()=>setItems(readSaved());sync();window.addEventListener(WORKSPACE_EVENT,sync);window.addEventListener('storage',sync);return()=>{window.removeEventListener(WORKSPACE_EVENT,sync);window.removeEventListener('storage',sync);};},[]);return items.length?<section className="panel overview-saved-changes"><SavedChanges items={items}/><Link className="text-link" href="/workspace">Manage saved objects →</Link></section>:null;}
