'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownRight } from 'lucide-react';

/** Keep snapshot-change recovery on the research page instead of navigating to API JSON. */
export function SnapshotExport({ href, restartHref }: { href: string; restartHref: string }) {
  const operation = useRef<AbortController | null>(null);
  const [pending,setPending]=useState(false), [message,setMessage]=useState(''), [refresh,setRefresh]=useState(false);
  useEffect(()=>()=>operation.current?.abort(),[]);
  return <div className="snapshot-export"><a className="button button-secondary button-small" href={href}
    aria-label="Export matching events" aria-disabled={pending} onClick={async event=>{
      event.preventDefault(); if(pending)return;
      const controller=new AbortController();operation.current=controller;
      setPending(true);setMessage('');setRefresh(false);
      try {
        const response=await fetch(href,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
        if(response.status===409){setRefresh(true);setMessage('New observations arrived. Refresh matching events before exporting.');return;}
        if(!response.ok || !response.headers.get('content-type')?.startsWith('text/csv')){
          setMessage('The export could not be prepared. Try a smaller selection or refresh this view.');return;
        }
        const url=URL.createObjectURL(await response.blob()), link=document.createElement('a');
        link.href=url;link.download='primusscope-network-observations.csv';document.body.appendChild(link);link.click();link.remove();
        window.setTimeout(()=>URL.revokeObjectURL(url),30000);setMessage('Matching events downloaded.');
      } catch {
        if(!controller.signal.aborted)setMessage('The export could not be reached. Try again.');
      } finally {setPending(false);}
    }}>{pending?'Preparing export…':'Export matching events'} <ArrowDownRight size={14} /></a>
    {message && <p role={refresh?'alert':'status'}>{message}</p>}
    {refresh && <a className="text-link" href={restartHref}>Refresh matching events</a>}
  </div>;
}
