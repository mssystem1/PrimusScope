'use client';
import {useEffect,useState,type ReactNode} from 'react';

// React applies select defaults during hydration. Prevent an early interaction
// from being silently replaced by that default on a slow connection or device.
export function ReadyFields({children,className,label}:{children:ReactNode;className:string;label:string}){
  const [ready,setReady]=useState(false);
  useEffect(()=>setReady(true),[]);
  return <><fieldset className={'ready-fields '+className} disabled={!ready} aria-busy={!ready} aria-label={label}>{children}</fieldset><noscript><p>Enable JavaScript to use these filters.</p></noscript></>;
}
