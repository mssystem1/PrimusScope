'use client';
import{Download}from'lucide-react';
import type{ComparisonGroup}from'@primusscope/data';
const date=(value:string|null)=>value?value.replace('T',' ').replace(/\.\d{3}Z$/,' UTC'):'Choose a fixed period';
const reason={NO_FIXED_PERIOD:'Choose 24 hours, 7 days, 30 days, or custom UTC dates. All available history has no equivalent preceding window.',INCOMPLETE_COVERAGE:'Both full periods must be covered by the same registered source scope. Missing history is not zero activity.',MISSING_TIMESTAMPS:'Some relevant events have no sampled timestamp. Calendar changes are unavailable until those events can be placed in time.'};
export function PeriodComparison({title,data,snapshotId,source}:{title:string;data:ComparisonGroup;snapshotId:string;source:string}){
 const format=(value:string|null)=>{
  if(value===null)return'—';if(/^-?\d+$/.test(value))return new Intl.NumberFormat('en-US').format(BigInt(value));
  const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/, '').split('.'),digits=fraction.padEnd(3,'0');
  const minor=BigInt(whole!)*100n+BigInt(digits.slice(0,2))+(digits[2]!>='5'?1n:0n);
  return(negative&&minor!==0n?'-':'')+new Intl.NumberFormat('en-US').format(minor/100n)+'.'+String(minor%100n).padStart(2,'0');
 };
 function download(){
  const header=['metric','unit','current','previous','absolute_change','percent_change','current_from_utc','current_through_utc','previous_from_utc','previous_through_utc','current_complete','previous_complete','snapshot_id','source_scope'];
  const rows=data.metrics.map(m=>[m.label,m.unit,m.current??'',m.previous??'',m.delta??'',m.percentChange??'',data.current.from??'',data.current.to??'',data.previous.from??'',data.previous.to??'',String(data.current.complete),String(data.previous.complete),snapshotId,source]);
  const csv=[header,...rows].map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=title.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="panel period-comparison" aria-label={title} data-comparison-status={data.status}><div className="panel-heading"><div><h2>{title}</h2><p>Selected period versus the immediately preceding period of equal duration.</p></div><button className="button button-secondary button-small" aria-label={'Export comparison CSV for '+title} onClick={download}><Download size={14}/>Export comparison</button></div>
  {data.reason&&<p className="comparison-notice">{reason[data.reason]}</p>}
  <div className="comparison-periods"><p><strong>Selected · {data.current.complete?'covered':'not fully covered'}</strong><span>{date(data.current.from)} – {date(data.current.to)}</span></p><p><strong>Previous · {data.previous.complete?'covered':'not fully covered'}</strong><span>{date(data.previous.from)} – {date(data.previous.to)}</span></p></div>
  <div className="comparison-metrics">{data.metrics.map(metric=><article className="comparison-metric" key={metric.key}><h3>{metric.label} <small>{metric.unit}</small></h3><dl><div><dt>Selected</dt><dd>{format(metric.current)}</dd></div><div><dt>Previous</dt><dd>{format(metric.previous)}</dd></div><div><dt>Change</dt><dd>{metric.delta!==null&&Number(metric.delta)>0?'+':''}{format(metric.delta)}</dd></div></dl><p>{metric.percentChange===null?metric.previous==='0'?'Percentage unavailable: previous value is zero.':'Percentage change unavailable.':(metric.percentChange>0?'+':'')+new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(metric.percentChange)+'% versus previous'}</p></article>)}</div>
  <div className="panel-footnote">{source} Changes appear only when both periods are fully covered. Displayed token amounts are rounded to two decimals; the CSV retains exact values and differences. Net-flow percentages use the absolute previous value; a percentage is not shown for a zero baseline.</div>
 </section>;
}
