import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { diagnosticsNeonClient, SDKDiagnosticsStore, DiagnosticStorageError, type DiagnosticStorageCode } from './diagnostics';
import type { SqlClient } from './postgres';
import type { DiagnosticEvent } from '@primusscope/api-schema/sdk-diagnostics';

const dbs:PGlite[]=[];
async function fixture(){
  const db=new PGlite();dbs.push(db);
  const client:SqlClient={async query(sql,values=[]){const r=await db.query<Record<string,unknown>>(sql,values);return{rows:r.rows};}};
  const store=new SDKDiagnosticsStore(client);await store.migrate();return{db,client,store};
}
afterEach(async()=>{for(const db of dbs.splice(0))await db.close();});
const owner='a'.repeat(64),other='b'.repeat(64),key='c'.repeat(64);
function event(eventId='10000000-0000-4000-8000-000000000001'):DiagnosticEvent{return{eventId,sdk:'@primuslabs/zktls-page-core-sdk',version:'0.2.1',operation:'verifyAttestation',durationMs:12,outcome:'rejected',sdkInvoked:true,isTest:false,errorCode:'SIGNATURE_REJECTED',runtime:'browser'};}
const appId='20000000-0000-4000-8000-000000000001';
async function create(store:SDKDiagnosticsStore,id=appId,ownerHash=owner,keyHash=key){return store.create(ownerHash,{id,name:'Site',origin:'https://example.com',ingestHash:keyHash});}
async function code(p:Promise<unknown>,expected:DiagnosticStorageCode){await expect(p).rejects.toMatchObject({name:'DiagnosticStorageError',code:expected});}

describe('hosted SDK diagnostics storage',()=>{
  it('rejects untrusted Neon endpoints without echoing connection details',()=>{
    expect(()=>diagnosticsNeonClient('postgres://secret:password@untrusted.example/db')).toThrow(DiagnosticStorageError);
    try{diagnosticsNeonClient('postgres://secret:password@untrusted.example/db');}catch(e){expect((e as Error).message).not.toContain('secret');expect((e as Error).message).not.toContain('password');}
  });
  it('enforces per-app authorization, owner isolation, and SQL least privilege',async()=>{
    const {db,store}=await fixture();await create(store);
    expect(await store.list(other)).toEqual([]);
    await code(store.detail(other,appId),'NOT_FOUND');
    await code(store.append({id:appId,ingestHash:'d'.repeat(64)},[event()]),'NOT_FOUND');
    await db.query('CREATE ROLE diag_runtime NOLOGIN');
    await db.query('CREATE ROLE diag_stranger NOLOGIN');
    await db.query('GRANT USAGE ON SCHEMA primusscope_diagnostics TO diag_runtime');
    await db.query(`GRANT EXECUTE ON FUNCTION primusscope_diagnostics.append_events(uuid,text,text,jsonb) TO diag_runtime`);
    await db.query('SET ROLE diag_runtime');
    await expect(db.query('SELECT * FROM primusscope_diagnostics.apps')).rejects.toThrow('permission denied');
    const nested={...event(),sdk:{privatePayload:'secret'}};
    await expect(db.query('SELECT * FROM primusscope_diagnostics.append_events($1,NULL,$2,$3::jsonb)',[appId,key,JSON.stringify([nested])])).rejects.toThrow('DIAG_INVALID');
    await db.query('RESET ROLE');
    const privileges=await db.query<{apps:boolean;events:boolean;runtime_append:boolean;stranger_append:boolean}>(`SELECT has_table_privilege('diag_runtime','primusscope_diagnostics.apps','SELECT') AS apps,has_table_privilege('diag_runtime','primusscope_diagnostics.events','SELECT') AS events,has_function_privilege('diag_runtime','primusscope_diagnostics.append_events(uuid,text,text,jsonb)','EXECUTE') AS runtime_append,has_function_privilege('diag_stranger','primusscope_diagnostics.append_events(uuid,text,text,jsonb)','EXECUTE') AS stranger_append`);
    expect(privileges.rows[0]).toEqual({apps:false,events:false,runtime_append:true,stranger_append:false});
  });
  it('stores only strict event metadata and applies dedupe and conflict atomically',async()=>{
    const {store,db}=await fixture();await create(store);
    const e=event();
    expect(await store.append({id:appId,ingestHash:key},[e])).toEqual({accepted:1,duplicates:0});
    expect(await store.append({id:appId,ownerHash:owner},[e])).toEqual({accepted:0,duplicates:1});
    const altered={...e,outcome:'error' as const};
    await code(store.append({id:appId,ownerHash:owner},[event('10000000-0000-4000-8000-000000000002'),altered]),'CONFLICT');
    expect(Number((await db.query<{n:number}>('SELECT count(*) AS n FROM primusscope_diagnostics.events')).rows[0]!.n)).toBe(1);
    const bad={...e,privatePayload:'secret'};
    await code(store.append({id:appId,ingestHash:key},[bad as DiagnosticEvent]),'INVALID_INPUT');
    expect((await db.query<{event_json:unknown}>('SELECT event_json FROM primusscope_diagnostics.events')).rows[0]!.event_json).toEqual(e);
    const detail=await store.detail(owner,appId);expect(detail?.events[0]).toMatchObject({...e,receivedAt:expect.any(String)});
    expect(JSON.stringify(detail)).not.toContain('privatePayload');
  });
  it('caps apps and event rows, rotates and revokes keys, and clears/deletes owner data',async()=>{
    const {store}=await fixture();
    await create(store,appId);await create(store,'20000000-0000-4000-8000-000000000002');await create(store,'20000000-0000-4000-8000-000000000003');
    await code(create(store,'20000000-0000-4000-8000-000000000004'),'QUOTA_EXCEEDED');
    await store.rotate(owner,appId,'d'.repeat(64));
    await code(store.append({id:appId,ingestHash:key},[event()]),'NOT_FOUND');
    await store.append({id:appId,ingestHash:'d'.repeat(64)},[event()]);
    await store.clear(owner,appId);expect((await store.detail(owner,appId))?.events).toEqual([]);
    const many=Array.from({length:25},(_,i)=>event(`30000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`));
    // Fill capacity in complete batches; the final overflowing batch is rolled back.
    for(let i=0;i<40;i++)await store.append({id:appId,ownerHash:owner},many.slice(0, i===39?25:25).map((e,j)=>event(`40000000-0000-4000-8000-${String(i*25+j+1).padStart(12,'0')}`)));
    await code(store.append({id:appId,ownerHash:owner},[event('50000000-0000-4000-8000-000000000001')]),'QUOTA_EXCEEDED');
    expect(await store.delete(owner,appId)).toBe(true);
    expect(await store.origin(appId)).toBeNull();
  });
  it('prunes expired records and enforces the daily registration bucket cap',async()=>{
    const {store,db}=await fixture();await create(store);
    await store.append({id:appId,ingestHash:key},[event()]);
    await db.query("UPDATE primusscope_diagnostics.events SET received_at=clock_timestamp()-interval '8 days'");
    await store.prune();expect((await store.detail(owner,appId))?.events).toEqual([]);
    await db.query("UPDATE primusscope_diagnostics.apps SET expires_at=clock_timestamp()-interval '1 second'");
    await store.prune();expect(await store.origin(appId)).toBeNull();
    const bucket='e'.repeat(64);for(let i=0;i<10;i++)expect(await store.allowRegistration(bucket)).toBe(true);
    expect(await store.allowRegistration(bucket)).toBe(false);
  });
});
