import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {SDKDiagnosticsStore,DiagnosticStorageError,diagnosticsNeonClient} from '@primusscope/storage/diagnostics';
import {DiagnosticBatchSchema,RegisterDiagnosticAppSchema} from '@primusscope/api-schema/sdk-diagnostics';
import {readJson,HttpError} from './http';

const COOKIE='primusscope_sdk_owner';
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
const validToken=(value:string)=>/^[a-zA-Z0-9_-]{43}$/.test(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function ownerToken(request:Request){const entries=(request.headers.get('cookie')??'').split(';').map(pair=>pair.trim()).filter(pair=>pair.startsWith(COOKIE+'='));if(entries.length!==1)return null;const value=entries[0]!.slice(COOKIE.length+1);return validToken(value)?value:null;}
class ApiFailure extends Error{constructor(readonly code:string,readonly status:number){super(code);}}
const headers={'Cache-Control':'private, no-store','Vary':'Origin, Cookie'};
const json=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json(body,{status,headers:{...headers,...extra}});
function sameOrigin(request:Request){if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiFailure('FORBIDDEN',403);}
function runtimeStore(){const connection=process.env.DIAGNOSTICS_DATABASE_URL;if(!connection)throw new ApiFailure('UNAVAILABLE',503);return new SDKDiagnosticsStore(diagnosticsNeonClient(connection));}
export function registrationBucket(request:Request,secret:string,now=new Date()){
 const forwarded=process.env.VERCEL==='1'?(request.headers.get('x-vercel-forwarded-for')??request.headers.get('x-forwarded-for')??'unknown'):'local';
 const candidate=forwarded.split(',')[0]!.trim(),ip=isIP(candidate)?candidate:'unknown';
 return createHmac('sha256',secret).update('sdk-register-v1:'+now.toISOString().slice(0,10)+':'+ip).digest('hex');
}
export async function handleDeveloperRequest(request:Request,segments:string[],injectedStore?:SDKDiagnosticsStore){
 let cors:Record<string,string>={};
 try{
  const url=new URL(request.url),method=request.method;
  if(url.search||segments.length>3||segments.some(part=>part.length>80))throw new ApiFailure('INVALID_INPUT',400);
  const owner=ownerToken(request),hash=owner?tokenHash(owner):null;
  if(segments[0]!=='apps')throw new ApiFailure('NOT_FOUND',404);
  const appId=segments[1],action=segments[2];
  if(appId&&!uuid.test(appId))throw new ApiFailure('NOT_FOUND',404);
  if(!appId&&method==='GET'){
    if(!hash)return json({apps:[],retentionDays:7,limit:3,ownership:'this_browser'});
    const store=injectedStore??runtimeStore();return json({apps:await store.list(hash),retentionDays:7,limit:3,ownership:'this_browser'});
  }
  if(!appId&&method==='POST'){
    sameOrigin(request);const body=RegisterDiagnosticAppSchema.safeParse(await readJson(request,4096));if(!body.success)throw new ApiFailure('INVALID_INPUT',400);
    const secret=process.env.DIAGNOSTICS_RATE_LIMIT_SECRET;if(!secret||secret.length<40)throw new ApiFailure('UNAVAILABLE',503);
    const store=injectedStore??runtimeStore();if(!await store.allowRegistration(registrationBucket(request,secret)))return json({code:'RATE_LIMITED'},429,{'Retry-After':'86400'});
    const owned=owner??token(),ingestToken=token();const app=await store.create(tokenHash(owned),{id:randomUUID(),name:body.data.name,origin:body.data.origin,ingestHash:tokenHash(ingestToken)});
    return json({app,ingestToken},201,{'Set-Cookie':`${COOKIE}=${owned}; HttpOnly; SameSite=Strict; Path=/api/v1/developer; Max-Age=604800${url.protocol==='https:'?'; Secure':''}`});
  }
  if(!appId)throw new ApiFailure('METHOD_NOT_ALLOWED',405);
  const store=injectedStore??runtimeStore();
  if(action==='events'&&(method==='POST'||method==='OPTIONS')){
    if(method==='POST'&&!/^Bearer [a-zA-Z0-9_-]{43}$/.test(request.headers.get('authorization')??''))throw new ApiFailure('UNAUTHORIZED',401);
    const origin=request.headers.get('origin'),allowed=await store.origin(appId);
    if(!allowed)throw new ApiFailure('NOT_FOUND',404);
    if(origin){if(origin!==allowed)throw new ApiFailure('FORBIDDEN',403);cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'};}
    if(method==='OPTIONS'){if(!origin)throw new ApiFailure('FORBIDDEN',403);return new Response(null,{status:204,headers:{...headers,...cors}});}
    const parsed=DiagnosticBatchSchema.safeParse(await readJson(request,32768));if(!parsed.success)throw new ApiFailure('INVALID_INPUT',400);
    const key=request.headers.get('authorization')!.slice(7);
    return json(await store.append({id:appId,ingestHash:tokenHash(key)},parsed.data.events),200,cors);
  }
  if(!hash)throw new ApiFailure('NOT_FOUND',404);
  if(method!=='GET')sameOrigin(request);
  if(!action&&method==='GET'){const detail=await store.detail(hash,appId);if(!detail)throw new ApiFailure('NOT_FOUND',404);return json(detail);}
  if(!action&&method==='DELETE'){if(!await store.delete(hash,appId))throw new ApiFailure('NOT_FOUND',404);return json({deleted:true});}
  if(action==='events'&&method==='DELETE'){if(!await store.clear(hash,appId))throw new ApiFailure('NOT_FOUND',404);return json({deleted:true});}
  if(action==='rotate'&&method==='POST'){
    const parsed=await readJson(request,64);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object'||Object.keys(parsed).length)throw new ApiFailure('INVALID_INPUT',400);
    const ingestToken=token(),app=await store.rotate(hash,appId,tokenHash(ingestToken));if(!app)throw new ApiFailure('NOT_FOUND',404);return json({app,ingestToken});
  }
  if(action==='record'&&method==='POST'){
    const parsed=DiagnosticBatchSchema.safeParse(await readJson(request,32768));if(!parsed.success)throw new ApiFailure('INVALID_INPUT',400);
    return json(await store.append({id:appId,ownerHash:hash},parsed.data.events));
  }
  throw new ApiFailure('METHOD_NOT_ALLOWED',405);
 }catch(error){
  if(error instanceof ApiFailure)return json({code:error.code},error.status,cors);
  if(error instanceof DiagnosticStorageError){const status=error.code==='NOT_FOUND'?404:error.code==='QUOTA_EXCEEDED'?429:error.code==='CONFLICT'?409:error.code==='INVALID_INPUT'?400:503;return json({code:error.code},status,cors);}
  if(error instanceof HttpError)return json({code:error.status===413?'PAYLOAD_TOO_LARGE':'INVALID_INPUT'},error.status,cors);
  return json({code:'UNAVAILABLE'},503,cors);
 }
}
