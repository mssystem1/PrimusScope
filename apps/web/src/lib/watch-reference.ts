import {z} from 'zod';
import {AddressSchema,HashSchema,DecimalStringSchema} from '@primusscope/api-schema';
import {parseNetworkPageQuery} from './network-query';
import {analyticsQuery} from './analytics-query';
export type WatchReference={kind:'task';domain:'network';contract:string;task:string}|{kind:'batch';domain:'finance';contract:string;batch:string}|{kind:'vault';domain:'finance';routeId:string}|{kind:'view';domain:'finance'|'network';query:string};
/** Recognized local routes only. Nothing here is an external URL or fetch target. */
export function watchReference(href:string):WatchReference|null{
 try{
  if(!href.startsWith('/')||href.startsWith('//')||href.includes('\\')||href.length>512)return null;
  const url=new URL(href,'https://primusscope.invalid');if(url.origin!=='https://primusscope.invalid'||!['','#activity'].includes(url.hash))return null;
  const p=url.pathname.split('/').filter(Boolean),query:Record<string,string>=Object.create(null);
  for(const[k,v]of url.searchParams){if(Object.hasOwn(query,k))return null;query[k]=v;}
  if(p[0]==='network'&&p[1]==='tasks'&&p.length===5&&p[2]==='8453'&&!url.search&&!url.hash)return{kind:'task',domain:'network',contract:AddressSchema.parse(p[3]).toLowerCase(),task:HashSchema.parse(p[4]).toLowerCase()};
  if(p[0]==='finance'&&p[1]==='batches'&&p.length===4&&!url.search&&!url.hash)return{kind:'batch',domain:'finance',contract:AddressSchema.parse(p[2]).toLowerCase(),batch:DecimalStringSchema.parse(p[3])};
  if(p[0]==='finance'&&p[1]==='vaults'&&p.length===3&&!url.hash){const routeId=z.string().regex(/^[a-z0-9-]{1,100}$/).parse(p[2]);if(!url.search)return{kind:'vault',domain:'finance',routeId};analyticsQuery.parse(query);return{kind:'view',domain:'finance',query:new URLSearchParams(Object.entries({...query,routeId}).sort(([a],[b])=>a.localeCompare(b))).toString()};}
  if(p.length!==1||!['finance','network'].includes(p[0]!))return null;
  if(p[0]==='finance')analyticsQuery.parse(query);else{const parsed=parseNetworkPageQuery(query);if(parsed.cursor)return null;}
  const normalized=new URLSearchParams(Object.entries(query).sort(([a],[b])=>a.localeCompare(b))).toString();return{kind:'view',domain:p[0] as 'finance'|'network',query:normalized};
 }catch{return null;}
}
