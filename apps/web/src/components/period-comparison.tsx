'use client';
import{ArrowLeft,ArrowRight,Download,Minus}from'lucide-react';
import type{ComparisonGroup,ComparisonMetric}from'@primusscope/data';
const date=(value:string|null)=>value?value.replace('T',' ').replace(/\.\d{3}Z$/,' UTC'):'Choose a fixed period';
const reason={NO_FIXED_PERIOD:'Choose 24 hours, 7 days, 30 days, or custom UTC dates. All available history has no equivalent preceding window.',INCOMPLETE_COVERAGE:'Both full periods must be covered by the same registered source scope. Missing history is not zero activity.',MISSING_TIMESTAMPS:'Some relevant events have no sampled timestamp. Calendar changes are unavailable until those events can be placed in time.'};
function FlowDirection({metric}:{metric:ComparisonMetric}){
 if(metric.unit!=='USDu'||metric.current===null)return null;
 const direction=metric.key==='deposits'?1:metric.key==='withdrawals'?-1:Math.sign(Number(metric.current));
 const label=metric.key==='deposits'?'Capital in':metric.key==='withdrawals'?'Capital out':direction<0?'Net outflow':direction>0?'Net inflow':'Balanced flows';
 const Icon=direction<0?ArrowLeft:direction>0?ArrowRight:Minus;
 return <span className="comparison-direction"><Icon size={14} aria-hidden="true"/>{label}</span>;
}
function ComparisonBars({metric}:{metric:ComparisonMetric}){
 if(metric.current===null||metric.previous===null)return null;
 const values=[Number(metric.current),Number(metric.previous)];
 if(!values.every(Number.isFinite))return null;
 const low=Math.min(0,...values),high=Math.max(0,...values),span=high-low||1;
 const x=(value:number)=>8+(value-low)/span*304,zero=x(0);
 return <svg className="comparison-bars" viewBox="0 0 320 85" aria-hidden="true">
  {[8,160,312].map(at=><line key={at} x1={at} x2={at} y1="5" y2="66" className="comparison-bar-grid"/>)}
  {values.map((value,index)=><rect key={index} x={Math.min(zero,x(value))} y={index===0?8:42} width={Math.abs(x(value)-zero)} height="20" rx="2" className={index===0?'comparison-bar-selected':'comparison-bar-previous'}/>)}
  <line x1={zero} x2={zero} y1="4" y2="66" className="comparison-bar-zero"/>
  <text x={zero} y="81" textAnchor={zero>300?'end':zero<20?'start':'middle'}>0</text>
 </svg>;
}
export function PeriodComparison({title,data,snapshotId,source,description,periodLinks}:{title:string;data:ComparisonGroup;snapshotId:string;source:string;description:string;periodLinks:{label:string;href:string}[]}){
 const fixed=data.reason!=='NO_FIXED_PERIOD',hasValues=data.metrics.some(metric=>metric.current!==null||metric.previous!==null);
 const format=(value:string|null)=>{
  if(value===null)return'Unavailable';if(/^-?\d+$/.test(value))return new Intl.NumberFormat('en-US').format(BigInt(value));
  const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/, '').split('.'),digits=fraction.padEnd(3,'0');
  const minor=BigInt(whole!)*100n+BigInt(digits.slice(0,2))+(digits[2]!>='5'?1n:0n);
  return(negative&&minor!==0n?'-':'')+new Intl.NumberFormat('en-US').format(minor/100n)+'.'+String(minor%100n).padStart(2,'0');
 };
 function download(){
  const header=['metric','unit','current','previous','absolute_change','percent_change','current_from_utc','current_through_utc','previous_from_utc','previous_through_utc','current_complete','previous_complete','snapshot_id','source_scope'];
  const rows=data.metrics.map(m=>[m.label,m.unit,m.current??'',m.previous??'',m.delta??'',m.percentChange??'',data.current.from??'',data.current.to??'',data.previous.from??'',data.previous.to??'',String(data.current.complete),String(data.previous.complete),snapshotId,source]);
  const csv=[header,...rows].map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=title.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="panel period-comparison" aria-label={title} data-comparison-status={data.status}><div className="panel-heading"><div><h2>{title}</h2><p>{description}</p></div>{hasValues&&<button className="button button-secondary button-small" aria-label={'Export comparison CSV for '+title} onClick={download}><Download size={14}/>Export comparison</button>}</div>
  {data.reason&&<p className="comparison-notice">{reason[data.reason]}</p>}
  <nav className="comparison-actions" aria-label={title+' periods'}>{periodLinks.map(link=><a className="button button-secondary button-small" key={link.href} href={link.href}>{link.label}</a>)}</nav>
  {fixed&&<div className="comparison-periods">{([['Selected',data.current],['Previous',data.previous]] as const).map(([label,period])=><p key={label}><strong>{label} · {period.complete?'covered':'not fully covered'}</strong><span>{date(period.from)} – {date(period.to)}</span>{!period.complete&&<span>{period.coveredFrom&&period.coveredTo?`Source time overlap: ${date(period.coveredFrom)} – ${date(period.coveredTo)}`:'No fully covered history in this period.'}</span>}</p>)}</div>}
  {hasValues&&<>
   {data.status==='available'&&<div className="comparison-legend"><span><i className="comparison-swatch-selected"/>Selected</span><span><i className="comparison-swatch-previous"/>Previous</span><small>Equal-duration periods · compare bars within each card</small></div>}
   <div className="comparison-metrics">{data.metrics.map(metric=><article className="comparison-metric" key={metric.key}><h3>{metric.label} <small>{metric.unit}</small></h3><FlowDirection metric={metric}/><ComparisonBars metric={metric}/><dl><div><dt>Selected</dt><dd>{format(metric.current)}</dd></div><div><dt>Previous</dt><dd>{format(metric.previous)}</dd></div><div><dt>Change</dt><dd>{metric.delta!==null&&Number(metric.delta)>0?'+':''}{format(metric.delta)}</dd></div></dl>{metric.percentChange!==null?<p className="comparison-change">{(metric.percentChange>0?'+':'')+new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(metric.percentChange)}% versus previous</p>:metric.previous!==null&&Number(metric.previous)===0?<p>Percentage unavailable: previous value is zero.</p>:null}</article>)}</div>
  </>}
  <details className="panel-footnote comparison-details"><summary>Source &amp; calculation details</summary><p>{source}</p>{hasValues&&<p>Changes appear only when both periods are fully covered. Displayed token amounts are rounded to two decimals; the CSV retains exact values and differences. Net-flow percentages use the absolute previous value; a percentage is not shown for a zero baseline.</p>}</details>
 </section>;
}
