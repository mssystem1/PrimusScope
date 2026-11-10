import {expect,test} from '@playwright/test';
import primus from '@primuslabs/zktls-page-core-sdk';
import fixture from '../../apps/web/src/fixtures/negative-attestation.json' with {type:'json'};

// Live one-time API credentials and owner cookies must never enter traces,
// screenshots, attachments or assertion output. Both projects are deleted.
test.use({trace:'off',screenshot:'off'});
test('hosted SDK diagnostics enforce ownership, consent, strict events, key revocation and deletion',async({request,playwright,baseURL},testInfo)=>{
 test.setTimeout(90000);const origin=new URL(baseURL!).origin;
 const other=await playwright.request.newContext({baseURL,proxy:testInfo.project.use.proxy});
 const ids:{context:typeof request;id:string}[]=[];
 try{
  const register=async(context:typeof request,name:string)=>{const response=await context.post('/api/v1/developer/apps',{headers:{Origin:origin},data:{name,origin,consent:true}});expect(response.status()).toBe(201);const app=await response.json();ids.push({context,id:app.app.id});expect(/^[\w-]{43}$/.test(app.ingestToken)).toBe(true);expect((response.headers()['set-cookie']??'').includes('HttpOnly')).toBe(true);return app;};
  const a=await register(request,'SDK release validation A'),b=await register(other,'SDK release validation B');
  expect((await request.get('/api/v1/developer/apps/'+b.app.id)).status()).toBe(404);
  expect((await other.get('/api/v1/developer/apps/'+a.app.id)).status()).toBe(404);
  const started=performance.now(),matches=primus.PrimusPageCoreTLS.prototype.verifyAttestation(fixture);
  expect(matches).toBe(false);
  const event={eventId:crypto.randomUUID(),sdk:'@primuslabs/zktls-page-core-sdk',version:'0.2.1',operation:'verifyAttestation',durationMs:Math.round((performance.now()-started)*100)/100,outcome:'rejected',sdkInvoked:true,isTest:true,errorCode:'SIGNER_MISMATCH',runtime:'browser'};
  const path='/api/v1/developer/apps/'+a.app.id+'/events',auth={Authorization:'Bearer '+a.ingestToken,Origin:origin};
  expect((await request.post(path,{headers:auth,data:{events:[{...event,proof:'FORBIDDEN_PRIVATE_PAYLOAD'}]}})).status()).toBe(400);
  expect((await request.post(path,{headers:{...auth,Origin:'https://wrong.invalid'},data:{events:[event]}})).status()).toBe(403);
  const first=await request.post(path,{headers:auth,data:{events:[event]}});expect(first.status()).toBe(200);expect(await first.json()).toEqual({accepted:1,duplicates:0});
  const again=await request.post(path,{headers:auth,data:{events:[event]}});expect(await again.json()).toEqual({accepted:0,duplicates:1});
  expect((await request.post(path,{headers:auth,data:{events:[{...event,durationMs:event.durationMs+1}]}})).status()).toBe(409);
  const detail=await(await request.get('/api/v1/developer/apps/'+a.app.id)).json();expect(detail.events).toHaveLength(1);expect(JSON.stringify(detail).includes(a.ingestToken)).toBe(false);expect(/owner_hash|ingest_hash|FORBIDDEN_PRIVATE_PAYLOAD/.test(JSON.stringify(detail))).toBe(false);
  const rotated=await request.post('/api/v1/developer/apps/'+a.app.id+'/rotate',{headers:{Origin:origin},data:{}});expect(rotated.status()).toBe(200);const replacement=await rotated.json();
  expect((await request.post(path,{headers:auth,data:{events:[event]}})).status()).toBe(404);
  const allowed=await request.fetch(path,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});expect(allowed.status()).toBe(204);expect(allowed.headers()['access-control-allow-origin']).toBe(origin);
  expect((await request.post('/api/v1/developer/apps/'+b.app.id+'/events',{headers:{Authorization:'Bearer '+replacement.ingestToken,Origin:origin},data:{events:[event]}})).status()).toBe(404);
  expect((await request.delete(path,{headers:{Origin:origin}})).status()).toBe(200);
  expect((await(await request.get('/api/v1/developer/apps/'+a.app.id)).json()).events).toHaveLength(0);
 }finally{for(const item of ids)await item.context.delete('/api/v1/developer/apps/'+item.id,{headers:{Origin:origin}});await other.dispose();}
});
