'use client';
import { useState } from 'react';
import type { AnalyticsSelection } from '@primusscope/api-schema';
import { CopyButton, SaveButton } from './public-actions';

export function AnalyticsControls({action,options,viewHref,viewTitle,preservedFields=[]}:{action:string;options:AnalyticsSelection;viewHref:string;viewTitle:string;preservedFields?:[string,string][]}){
  const [range,setRange]=useState(options.range??'30d');
  return <div className="analytics-controls"><form action={action} method="get" aria-label="Analytics period">
    {preservedFields.map(([name,value])=><input type="hidden" key={name} name={name} value={value}/>)}
    <label htmlFor="analytics-range">Period</label><select id="analytics-range" name="range" value={range} onChange={e=>setRange(e.target.value as typeof range)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="all">All available</option><option value="custom">Custom UTC dates</option></select>
    {range==='custom'&&<><label htmlFor="analytics-from">From date · UTC<input id="analytics-from" type="date" name="from" required defaultValue={options.from}/></label><label htmlFor="analytics-to">Through date · UTC<input id="analytics-to" type="date" name="to" required defaultValue={options.to}/></label></>}
    <label htmlFor="analytics-interval">Activity buckets</label><select id="analytics-interval" name="interval" defaultValue={options.interval??'day'}><option value="day">Daily</option><option value="hour">Hourly</option></select><button className="button button-secondary" type="submit">Update dashboard</button>
  </form><div className="analytics-view-actions"><CopyButton value={viewHref} copyAsUrl label="Copy dashboard link"/><SaveButton compact item={{id:'view:analytics:'+viewHref,title:viewTitle,href:viewHref,domain:'view'}}/></div></div>;
}
export function AnalyticsSelectionError({action}:{action:string}){
  return <div className="notice" role="alert"><div><strong>Check the analytics dates</strong><p>Choose a supported period, or two real UTC dates in order (at most 366 days). Use Custom UTC dates to select dates. Each field may appear only once.</p><a className="text-link" href={action}>Reset analytics period</a></div></div>;
}
