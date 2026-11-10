'use client';

import { useId, useState } from 'react';
import { ArrowDownRight, ChevronLeft, ChevronRight } from 'lucide-react';

export type ChartRow = { label: string; [key: string]: string | number | null };
type BucketCoverage = {at:string;from:string;to:string;partial:boolean};
export type ChartSeries = { key: string; label: string; color: string };
const numeric=(value:unknown)=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
function timeLabel(value:string,full=false){
  if(!/^\d{4}-\d\d-\d\dT/.test(value))return value;
  return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',...(full?{year:'numeric',hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(value))+(full?' UTC':'');
}

export function AnalyticsChart({ title, description, rows, series, type='line', unit='events', precision=0, startAtZero=true, source, bucketCoverage }: {
  title:string; description:string; rows:ChartRow[]; series:ChartSeries[]; type?:'line'|'bar';unit?:string; precision?:number;startAtZero?:boolean;source:string;bucketCoverage?:BucketCoverage[];
}){
  const bucketByTime=new Map(bucketCoverage?.map(bucket=>[bucket.at,bucket]));
  const id=useId(),[visible,setVisible]=useState(series.map(s=>s.key)),[active,setActive]=useState(Math.max(0,rows.length-1));
  const selected=series.filter(s=>visible.includes(s.key)),values=rows.flatMap(row=>selected.map(s=>numeric(row[s.key])).filter((v):v is number=>v!==null));
  let low=values.length?Math.min(...values):0,high=values.length?Math.max(...values):1;
  if(startAtZero||type==='bar'){low=Math.min(0,low);high=Math.max(0,high);}
  if(high===low){high+=high===0?1:Math.abs(high)*.05;low=startAtZero?Math.min(0,low):low-Math.abs(low)*.05;}
  const span=high-low, y=(value:number)=>220-((value-low)/span)*220;
  const times=rows.map(row=>/^\d{4}-\d\d-\d\dT/.test(row.label)?Date.parse(row.label):NaN);
  const timeAxis=times.length>1&&times.every(Number.isFinite)&&times.at(-1)!>times[0]!;
  const x=(index:number)=>rows.length<=1?400:timeAxis?((times[index]!-times[0]!)/(times.at(-1)!-times[0]!))*800:(index/(rows.length-1))*800;
  const axisLabels=timeAxis?[times[0]!,times[0]!+(times.at(-1)!-times[0]!)/2,times.at(-1)!].map(t=>new Date(t).toISOString())
    :[...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])].map(i=>rows[i]?.label??'');
  const index=Math.min(active,Math.max(0,rows.length-1)),row=rows[index];
  const shortLabel=(label:string)=>/^\d{4}-\d\d-\d\dT/.test(label)&&rows.length>1
    &&Date.parse(rows.at(-1)!.label)-Date.parse(rows[0]!.label)<2*86400000
    ?new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(label)):timeLabel(label);
  const format=(value:unknown,compact=false)=>numeric(value)===null?'Not measured':new Intl.NumberFormat('en-US',
    {maximumFractionDigits:precision,minimumFractionDigits:precision>0&&!compact?Math.min(precision,2):0,...(compact&&Math.abs(Number(value))>=10000?{notation:'compact' as const,maximumFractionDigits:1}:{})}).format(Number(value));
  const download=()=>{
    const table=[['time_or_category',...series.map(s=>s.label+' ('+unit+')'),...(bucketCoverage?['covered_from_utc','covered_through_utc','partial_bucket']:[])],...rows.map(row=>[row.label,...series.map(s=>row[s.key]??''),...(bucketCoverage?[bucketByTime.get(row.label)?.from??'',bucketByTime.get(row.label)?.to??'',String(bucketByTime.get(row.label)?.partial??'')]:[])])];
    const csv=table.map(cells=>cells.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download=title.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.csv';a.click();window.setTimeout(()=>URL.revokeObjectURL(url),30000);
  };
  return <section className="panel analytics-chart" aria-labelledby={id}>
    <div className="analytics-chart-heading"><div><h3 id={id}>{title}</h3><p>{description}</p></div><button className="icon-button" type="button" aria-label={'Export chart data for '+title} onClick={download} disabled={!rows.length}><ArrowDownRight size={17}/></button></div>
    <div className="analytics-legend" role="group" aria-label={'Series for '+title}>{series.map(s=><button key={s.key} type="button" aria-pressed={visible.includes(s.key)} onClick={()=>setVisible(visible.includes(s.key)?visible.length>1?visible.filter(key=>key!==s.key):visible:[...visible,s.key])}><span style={{background:s.color}}/>{s.label}</button>)}<span className="analytics-unit">{unit}</span></div>
    {values.length?<>
      <div className="analytics-plot"><div className="analytics-y-axis" aria-hidden="true">{[1,.75,.5,.25,0].map(f=><span key={f}>{format(low+span*f,true)}</span>)}</div><div className="analytics-svg-wrap">
        <svg viewBox="0 -3 800 226" preserveAspectRatio="none" role="img" aria-label={`${title}; ${rows.length} observations. Exact data is available in the table below.`}
          onPointerMove={event=>{const rect=event.currentTarget.getBoundingClientRect(),position=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));
            if(timeAxis&&type==='line'){const target=times[0]!+position*(times.at(-1)!-times[0]!);setActive(times.reduce((best,t,i)=>Math.abs(t-target)<Math.abs(times[best]!-target)?i:best,0));}
            else setActive(Math.max(0,Math.min(rows.length-1,Math.floor(position*rows.length))));}}>
          {[0,.25,.5,.75,1].map(f=><line key={f} x1="0" x2="800" y1={220*f} y2={220*f} stroke="#263540" strokeDasharray="3 5" vectorEffect="non-scaling-stroke"/>)}
          {low<0&&<line x1="0" x2="800" y1={y(0)} y2={y(0)} stroke="#8da4b1" vectorEffect="non-scaling-stroke"/>}
          {selected.map((s,si)=>{
            if(type==='bar')return <g key={s.key}>{rows.map((r,i)=>{const value=numeric(r[s.key]);if(value===null)return null;const group=800/Math.max(1,rows.length),width=Math.max(1,group*.7/selected.length);return <rect key={i} x={i*group+group*.15+si*width} y={Math.min(y(0),y(value))} width={width} height={Math.max(value===0?0:1,Math.abs(y(value)-y(0)))} fill={s.color} opacity=".88"/>;})}</g>;
            let path='',pen=false;for(let i=0;i<rows.length;i++){const value=numeric(rows[i]![s.key]);if(value===null){pen=false;continue;}path+=(pen?' L':' M')+x(i)+' '+y(value);pen=true;}
            return <g key={s.key}><path d={path} fill="none" stroke={s.color} strokeWidth="2.25" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>{rows.length===1&&numeric(rows[0]![s.key])!==null&&<circle cx="400" cy={y(Number(rows[0]![s.key]))} r="4" fill={s.color}/>}</g>;
          })}
          {row&&<line x1={type==='bar'?(index+.5)*800/rows.length:x(index)} x2={type==='bar'?(index+.5)*800/rows.length:x(index)} y1="0" y2="220" stroke="#a1b6c2" strokeDasharray="3 4" opacity=".6" vectorEffect="non-scaling-stroke"/>}
        </svg><div className="analytics-x-axis" aria-hidden="true">{axisLabels.map((label,i)=><span key={i}>{shortLabel(label)}</span>)}</div>
      </div></div>
      <div className="analytics-inspector"><div className="analytics-inspector-values" aria-live="polite"><strong>{row?timeLabel(row.label,true):''}</strong>{row&&bucketByTime.get(row.label)?.partial&&<small>Partial UTC bucket · {timeLabel(bucketByTime.get(row.label)!.from,true)} through {timeLabel(bucketByTime.get(row.label)!.to,true)}</small>}{selected.map(s=><span key={s.key}><i style={{background:s.color}}/>{s.label}: <b>{format(row?.[s.key])}</b></span>)}</div><div className="analytics-point-controls"><button type="button" className="icon-button" aria-label={'Previous observation in '+title} disabled={index===0} onClick={()=>setActive(index-1)}><ChevronLeft size={17}/></button><button type="button" className="icon-button" aria-label={'Next observation in '+title} disabled={index>=rows.length-1} onClick={()=>setActive(index+1)}><ChevronRight size={17}/></button></div></div>
    </>:<div className="analytics-chart-empty"><strong>No measured points for this selection</strong><p>Missing history stays unavailable. Choose a covered period or return after new observations.</p></div>}
    <div className="analytics-chart-foot"><p>{source}</p><details><summary>Explore chart data</summary><div className="table-scroll"><table><caption className="sr-only">Data for {title}</caption><thead><tr><th>Time / category</th>{series.map(s=><th key={s.key}>{s.label} ({unit})</th>)}{bucketCoverage&&<><th>Covered from · UTC</th><th>Covered through · UTC</th><th>Bucket coverage</th></>}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}><th scope="row">{timeLabel(r.label,true)}</th>{series.map(s=><td key={s.key}>{r[s.key]===null?'Not measured':String(r[s.key]??'')}</td>)}{bucketCoverage&&<><td>{bucketByTime.get(r.label)?.from??'—'}</td><td>{bucketByTime.get(r.label)?.to??'—'}</td><td>{bucketByTime.get(r.label)?.partial?'Partial UTC bucket':'Complete UTC bucket'}</td></>}</tr>)}</tbody></table></div></details></div>
  </section>;
}
