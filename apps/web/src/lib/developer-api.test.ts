import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { DiagnosticEvent } from '@primusscope/api-schema/sdk-diagnostics';
import { SDKDiagnosticsStore } from '@primusscope/storage/diagnostics';
import type { SqlClient } from '@primusscope/storage/postgres';
import { handleDeveloperRequest } from './developer-api';

const dbs:PGlite[]=[];
const oldSecret=process.env.DIAGNOSTICS_RATE_LIMIT_SECRET;
const secret='test-only-rate-limit-secret-0123456789abcdef';
afterEach(async()=>{
  for(const db of dbs.splice(0))await db.close();
  if(oldSecret===undefined)delete process.env.DIAGNOSTICS_RATE_LIMIT_SECRET;else process.env.DIAGNOSTICS_RATE_LIMIT_SECRET=oldSecret;
});
async function fixture(){
  const db=new PGlite();dbs.push(db);
  const client:SqlClient={async query(sql,values=[]){const result=await db.query<Record<string,unknown>>(sql,values);return{rows:result.rows};}};
  const store=new SDKDiagnosticsStore(client);await store.migrate();process.env.DIAGNOSTICS_RATE_LIMIT_SECRET=secret;return{db,store};
}
const base='https://scope.test/api/v1/developer';
const appOrigin='https://merchant.example';
const event=(id='10000000-0000-4000-8000-000000000001',outcome:DiagnosticEvent['outcome']='rejected'):DiagnosticEvent=>({
  eventId:id,sdk:'@primuslabs/zktls-page-core-sdk',version:'0.2.1',operation:'verifyAttestation',durationMs:14,
  outcome,sdkInvoked:true,isTest:false,errorCode:'SIGNATURE_REJECTED',runtime:'browser',
});
function request(path='',method='GET',options:{body?:unknown;headers?:Record<string,string>;url?:string}={}):Request{
  const headers=new Headers(options.headers),url=options.url??base+path;
  if(options.body!==undefined)headers.set('Content-Type',headers.get('Content-Type')??'application/json');
  headers.set('Origin',headers.get('Origin')??new URL(url).origin);
  return new Request(url,{method,headers,body:options.body===undefined?undefined:typeof options.body==='string'?options.body:JSON.stringify(options.body)});
}
async function call(store:SDKDiagnosticsStore,path='',method='GET',options:{body?:unknown;headers?:Record<string,string>;url?:string}={}){
  const req=request(path,method,options);return handleDeveloperRequest(req,path.split('/').filter(Boolean),store);
}
async function register(store:SDKDiagnosticsStore,options:{cookie?:string;origin?:string;name?:string;url?:string}={}){
  const headers:Record<string,string>={};if(options.cookie)headers.Cookie=options.cookie;if(options.origin)headers.Origin=options.origin;
  return call(store,'apps','POST',{body:{name:options.name??'Merchant app',origin:appOrigin,consent:true},headers,url:options.url});
}
function cookie(response:Response){const value=response.headers.get('set-cookie');expect(value).toBeTruthy();return value!.split(';')[0]!;}
function appId(body:any):string{return body.app.id;}
function ownerCookie(response:Response){return cookie(response);}
function bearer(key:string){return 'Bearer '+key;}
async function json(response:Response){return response.json() as Promise<any>;}

describe('developer diagnostics API',()=>{
  it('returns an empty browser-local list without a cookie, even without runtime configuration',async()=>{
    const previous=process.env.DIAGNOSTICS_DATABASE_URL;delete process.env.DIAGNOSTICS_DATABASE_URL;
    try{
      const empty=await handleDeveloperRequest(request('apps'),['apps']);
      expect(empty.status).toBe(200);expect(await json(empty)).toMatchObject({apps:[],retentionDays:7,limit:3,ownership:'this_browser'});
      expect((await handleDeveloperRequest(request('apps','GET',{headers:{Cookie:'primusscope_sdk_owner='+'a'.repeat(43)}}),['apps'])).status).toBe(503);
    }finally{if(previous===undefined)delete process.env.DIAGNOSTICS_DATABASE_URL;else process.env.DIAGNOSTICS_DATABASE_URL=previous;}
  });

  // The first PGlite database can take several seconds to compile its WASM on a cold runner.
  it('registers only with consent and origin checks, setting an opaque secure owner cookie',async()=>{
    const {store}=await fixture();
    const missing=await call(store,'apps','POST',{body:{name:'Merchant app',origin:appOrigin}});
    expect(missing.status).toBe(400);
    const invalid=await call(store,'apps','POST',{body:{name:'Merchant app',origin:'http://example.com',consent:true}});
    expect(invalid.status).toBe(400);
    const csrf=await register(store,{origin:'https://evil.example'});
    expect(csrf.status).toBe(403);
    const response=await register(store);
    expect(response.status).toBe(201);
    const cookieHeader=response.headers.get('set-cookie')!;
    expect(cookieHeader).toMatch(/^primusscope_sdk_owner=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api\/v1\/developer; Max-Age=604800; Secure$/);
    const body=await json(response);
    expect(body.app).toMatchObject({name:'Merchant app',origin:appOrigin,keyVersion:1});
    expect(body.ingestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(body)).not.toContain('ownerHash');
  },15000);

  it('isolates owner lists and details and never returns hashes or ingest credentials',async()=>{
    const {store}=await fixture();
    const one=await register(store),oneCookie=ownerCookie(one),oneBody=await json(one),oneId=appId(oneBody);
    const two=await register(store),twoCookie=ownerCookie(two),twoBody=await json(two),twoId=appId(twoBody);
    const listOne=await call(store,'apps','GET',{headers:{Cookie:oneCookie}}),listTwo=await call(store,'apps','GET',{headers:{Cookie:twoCookie}});
    expect((await json(listOne)).apps.map((a:any)=>a.id)).toEqual([oneId]);
    expect((await json(listTwo)).apps.map((a:any)=>a.id)).toEqual([twoId]);
    expect((await call(store,'apps/'+twoId,'GET',{headers:{Cookie:oneCookie}})).status).toBe(404);
    const record=await call(store,'apps/'+oneId+'/record','POST',{headers:{Cookie:oneCookie},body:{events:[event()]}});
    expect(record.status).toBe(200);
    const detail=await call(store,'apps/'+oneId,'GET',{headers:{Cookie:oneCookie}});
    const detailBody=await json(detail),serialized=JSON.stringify(detailBody);
    expect(detailBody.events).toHaveLength(1);
    expect(serialized).not.toContain(oneBody.ingestToken);
    expect(serialized).not.toContain(twoBody.ingestToken);
    expect(serialized).not.toContain('owner_hash');expect(serialized).not.toContain('ingest_hash');
    expect(serialized).not.toContain('ownerHash');expect(serialized).not.toContain('ingestHash');
    const privateEvent={...event('10000000-0000-4000-8000-000000000002'),privatePayload:'do not store'};
    expect((await call(store,'apps/'+oneId+'/record','POST',{headers:{Cookie:oneCookie},body:{events:[privateEvent]}})).status).toBe(400);
    expect((await json(await call(store,'apps/'+oneId,'GET',{headers:{Cookie:oneCookie}}))).events).toHaveLength(1);
  });

  it('applies bearer app and origin checks, CORS preflight, idempotency and conflict statuses',async()=>{
    const {store}=await fixture();
    const registered=await register(store),registeredCookie=ownerCookie(registered),body=await json(registered),id=appId(body),key=body.ingestToken;
    const path='apps/'+id+'/events';
    const wrongOrigin=await call(store,path,'POST',{headers:{Authorization:bearer(key),Origin:'https://other.example'},body:{events:[event()]}});
    expect(wrongOrigin.status).toBe(403);
    const wrongKey=await call(store,path,'POST',{headers:{Authorization:bearer('a'.repeat(43)),Origin:appOrigin},body:{events:[event()]}});
    expect(wrongKey.status).toBe(404);
    const unknownApp=await call(store,'apps/20000000-0000-4000-8000-000000000099/events','POST',{headers:{Authorization:bearer(key),Origin:appOrigin},body:{events:[event()]}});
    expect(unknownApp.status).toBe(404);
    const preflight=await call(store,path,'OPTIONS',{headers:{Origin:appOrigin}});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(appOrigin);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect((await call(store,path,'OPTIONS',{headers:{Origin:'https://other.example'}})).status).toBe(403);
    const first=await call(store,path,'POST',{headers:{Authorization:bearer(key),Origin:appOrigin},body:{events:[event()]}});
    expect(first.status).toBe(200);expect(await json(first)).toEqual({accepted:1,duplicates:0});
    const repeated=await call(store,path,'POST',{headers:{Authorization:bearer(key),Origin:appOrigin},body:{events:[event()]}});
    expect(await json(repeated)).toEqual({accepted:0,duplicates:1});
    const conflict=await call(store,path,'POST',{headers:{Authorization:bearer(key),Origin:appOrigin},body:{events:[event(event().eventId,'error')]}});
    expect(conflict.status).toBe(409);
    expect((await call(store,path,'POST',{headers:{Authorization:bearer('b'.repeat(43)),Origin:appOrigin},body:{events:[event()]}})).status).toBe(404);
    expect(registeredCookie).toContain('primusscope_sdk_owner=');
  });

  it('rotates ingest credentials, clears events and revokes the app on delete',async()=>{
    const {store}=await fixture();
    const registered=await register(store),cookieHeader=ownerCookie(registered),body=await json(registered),id=appId(body),path='apps/'+id;
    await call(store,path+'/record','POST',{headers:{Cookie:cookieHeader},body:{events:[event()]}});
    const rotated=await call(store,path+'/rotate','POST',{headers:{Cookie:cookieHeader},body:{}});
    expect(rotated.status).toBe(200);const newKey=(await json(rotated)).ingestToken;
    expect(newKey).not.toBe(body.ingestToken);
    const eventsPath=path+'/events';
    expect((await call(store,eventsPath,'POST',{headers:{Authorization:bearer(body.ingestToken),Origin:appOrigin},body:{events:[event('10000000-0000-4000-8000-000000000002')]}})).status).toBe(404);
    expect((await call(store,eventsPath,'POST',{headers:{Authorization:bearer(newKey),Origin:appOrigin},body:{events:[event('10000000-0000-4000-8000-000000000002')]}})).status).toBe(200);
    expect((await call(store,eventsPath,'DELETE',{headers:{Cookie:cookieHeader}})).status).toBe(200);
    expect((await json(await call(store,path,'GET',{headers:{Cookie:cookieHeader}}))).events).toEqual([]);
    expect((await call(store,path,'DELETE',{headers:{Cookie:cookieHeader}})).status).toBe(200);
    expect((await call(store,eventsPath,'POST',{headers:{Authorization:bearer(newKey),Origin:appOrigin},body:{events:[event('10000000-0000-4000-8000-000000000003')]}})).status).toBe(404);
  });

  it('rejects unknown segments, query strings, CSRF mismatches, oversized and non-JSON bodies',async()=>{
    const {store}=await fixture();const registered=await register(store),cookieHeader=ownerCookie(registered),body=await json(registered),path='apps/'+appId(body);
    expect((await call(store,'unknown')).status).toBe(404);
    expect((await call(store,path+'?leak=1')).status).toBe(400);
    expect((await call(store,path+'/unknown','POST',{headers:{Cookie:cookieHeader},body:{}})).status).toBe(405);
    expect((await call(store,path+'/record','POST',{headers:{Cookie:cookieHeader,Origin:'https://evil.example'},body:{events:[event()]}})).status).toBe(403);
    const oversized=await call(store,path+'/record','POST',{headers:{Cookie:cookieHeader},body:' '.repeat(33000)});
    expect(oversized.status).toBe(413);expect(await json(oversized)).toEqual({code:'PAYLOAD_TOO_LARGE'});
    const unsupported=await call(store,path+'/record','POST',{headers:{Cookie:cookieHeader,'Content-Type':'text/plain'},body:'{}'});
    expect(unsupported.status).toBe(415);
  });

  it('limits registration to ten attempts per hashed daily bucket',async()=>{
    const {store}=await fixture();
    const results=[];for(let i=0;i<10;i++)results.push(await register(store));
    expect(results.every(response=>response.status===201)).toBe(true);
    const limited=await register(store);
    expect(limited.status).toBe(429);expect(await json(limited)).toEqual({code:'RATE_LIMITED'});
    expect(limited.headers.get('Retry-After')).toBe('86400');
  });
});
