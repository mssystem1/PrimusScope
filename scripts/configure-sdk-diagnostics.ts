/** Administrative, additive schema/role bootstrap. Never prints credential values. */
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {neonClient} from '../packages/storage/src/postgres';
import {SDKDiagnosticsStore,diagnosticsNeonClient} from '../packages/storage/src/diagnostics';

let stage='read_configuration';
async function main(){
 const admin=parseEnv(await readFile('.local/neon-admin.env','utf8')),hosted=parseEnv(await readFile('.local/hosted-credentials.env','utf8'));
 const adminUrl=new URL(admin.DATABASE_URL!),workerUrl=new URL(hosted.WORKER_DATABASE_URL!);
 if(adminUrl.hostname.replace('-pooler.','.')!==workerUrl.hostname.replace('-pooler.','.')||adminUrl.pathname!==workerUrl.pathname)throw new Error('DATABASE_IDENTITY_MISMATCH');
 let configuration:{DIAGNOSTICS_DATABASE_URL:string;DIAGNOSTICS_RATE_LIMIT_SECRET:string};
 try{configuration=JSON.parse(await readFile('.local/sdk-runtime-credentials.json','utf8'));}
 catch{const url=new URL(admin.DATABASE_URL!);url.username='primusscope_diagnostics';url.password=randomBytes(32).toString('base64url');configuration={DIAGNOSTICS_DATABASE_URL:url.toString(),DIAGNOSTICS_RATE_LIMIT_SECRET:randomBytes(48).toString('base64url')};await writeFile('.local/sdk-runtime-credentials.json',JSON.stringify(configuration),{mode:0o600});}
 await chmod('.local/sdk-runtime-credentials.json',0o600);
 const client=neonClient(admin.DATABASE_URL!);stage='migrate_schema';await new SDKDiagnosticsStore(client).migrate();
 for(const sql of [
  'CREATE INDEX IF NOT EXISTS diagnostic_apps_owner ON primusscope_diagnostics.apps(owner_hash)',
  'CREATE INDEX IF NOT EXISTS diagnostic_apps_expiry ON primusscope_diagnostics.apps(expires_at)',
  'CREATE INDEX IF NOT EXISTS diagnostic_events_received ON primusscope_diagnostics.events(received_at)',
 ])await client.query(sql);
 const functions=['prune()','create_app(uuid,text,text,text,text)','list_apps(text)','app_detail(text,uuid)','rotate_key(text,uuid,text)','clear_app(text,uuid)','delete_app(text,uuid)','app_origin(uuid)','append_events(uuid,text,text,jsonb)','allow_registration(text)'];
 const statements=[
  `IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='primusscope_diagnostics') THEN CREATE ROLE primusscope_diagnostics LOGIN NOINHERIT NOCREATEROLE NOCREATEDB; END IF`,
  `EXECUTE format('ALTER ROLE primusscope_diagnostics PASSWORD %L',runtime_password)`,
  'REVOKE ALL ON ALL TABLES IN SCHEMA primusscope_diagnostics FROM primusscope_diagnostics',
  'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA primusscope_diagnostics FROM primusscope_diagnostics',
  'GRANT USAGE ON SCHEMA primusscope_diagnostics TO primusscope_diagnostics,primusscope_worker',
  ...functions.map(signature=>'GRANT EXECUTE ON FUNCTION primusscope_diagnostics.'+signature+' TO primusscope_diagnostics'),
  'GRANT EXECUTE ON FUNCTION primusscope_diagnostics.prune() TO primusscope_worker',
 ];
 stage='configure_role';await client.query(`CREATE OR REPLACE FUNCTION primusscope_diagnostics.configure_runtime(runtime_password text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN ${statements.join('; ')}; END $$`);
 try{
  await client.query('REVOKE ALL ON FUNCTION primusscope_diagnostics.configure_runtime(text) FROM PUBLIC');
  await client.query('SELECT primusscope_diagnostics.configure_runtime($1)',[decodeURIComponent(new URL(configuration.DIAGNOSTICS_DATABASE_URL).password)]);
 }finally{await client.query('DROP FUNCTION IF EXISTS primusscope_diagnostics.configure_runtime(text)');}
 const runtime=diagnosticsNeonClient(configuration.DIAGNOSTICS_DATABASE_URL);
 stage='check_privileges';const checks=await client.query(`SELECT has_schema_privilege('primusscope_diagnostics','primusscope_diagnostics','USAGE') AS usage,has_table_privilege('primusscope_diagnostics','primusscope_diagnostics.events','SELECT') AS event_select,has_table_privilege('primusscope_diagnostics','primusscope.publication','SELECT') AS publication_select,has_table_privilege('primusscope_diagnostics','primusscope.publication','UPDATE') AS publication_write,has_function_privilege('primusscope_diagnostics','primusscope_diagnostics.append_events(uuid,text,text,jsonb)','EXECUTE') AS append`);
 const permissions=checks.rows[0]!;if(!permissions.usage||!permissions.append||permissions.event_select||permissions.publication_select||permissions.publication_write)throw new Error('RUNTIME_PRIVILEGE_CHECK_FAILED');
 await new SDKDiagnosticsStore(runtime).list('0'.repeat(64));
 stage='collector_prune';const worker=neonClient(hosted.WORKER_DATABASE_URL!);await new SDKDiagnosticsStore(worker).prune();
 const environments=Object.entries(configuration).map(([key,value])=>({key,value,type:'encrypted',target:['production']}));
 await writeFile('.local/sdk-vercel-env-request.json',JSON.stringify(environments),{mode:0o600});await chmod('.local/sdk-vercel-env-request.json',0o600);
 await writeFile('.local/sdk-database-validation.json',JSON.stringify({observedAt:new Date().toISOString(),schema:'primusscope_diagnostics',permissions,collectorPrune:'passed',runtimeRole:'primusscope_diagnostics',environmentNames:Object.keys(configuration)},null,2));
 console.log(JSON.stringify({outcome:'configured',permissions,collectorPrune:'passed',environmentNames:Object.keys(configuration)}));
}
main().catch(error=>{console.error(JSON.stringify({outcome:'failed',code:'SDK_DIAGNOSTICS_CONFIGURATION_FAILED',stage,kind:error?.name==='DiagnosticStorageError'?'DIAGNOSTIC_STORAGE':error?.name==='StorageError'?'STORAGE':'CONFIGURATION'}));process.exitCode=1;});
