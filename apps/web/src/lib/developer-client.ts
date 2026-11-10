'use client';
import {diagnosticFromResult,type DiagnosticApp,type DiagnosticAppDetail,type InspectionResult} from './sdk-tools';
const base='/api/v1/developer';
export class DeveloperApiError extends Error{constructor(readonly code:string){super(code);}}
async function request<T>(path:string,method='GET',body?:unknown):Promise<T>{
  let response:Response,value:unknown;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{response=await fetch(base+path,{method,signal:controller.signal,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});value=await response.json().catch(()=>null);}
  catch{throw new DeveloperApiError('UNAVAILABLE');}
  finally{clearTimeout(timeout);}
  const code=value&&typeof value==='object'&&'code' in value?value.code:undefined;
  if(!response.ok)throw new DeveloperApiError(typeof code==='string'&&/^[A-Z_]{1,60}$/.test(code)?code:'UNAVAILABLE');
  return value as T;
}
export const listDiagnosticApps=()=>request<{apps:DiagnosticApp[];retentionDays:7;limit:3}>('/apps');
export const registerDiagnosticApp=(name:string,origin:string)=>request<{app:DiagnosticApp;ingestToken:string}>('/apps','POST',{name,origin,consent:true});
export const readDiagnosticApp=(id:string)=>request<DiagnosticAppDetail>('/apps/'+encodeURIComponent(id));
export const rotateDiagnosticKey=(id:string)=>request<{app:DiagnosticApp;ingestToken:string}>('/apps/'+encodeURIComponent(id)+'/rotate','POST',{});
export const clearDiagnosticEvents=(id:string)=>request<{deleted:true}>('/apps/'+encodeURIComponent(id)+'/events','DELETE');
export const deleteDiagnosticApp=(id:string)=>request<{deleted:true}>('/apps/'+encodeURIComponent(id),'DELETE');
export const recordInspection=(id:string,result:InspectionResult,isTest:boolean)=>request<{accepted:number;duplicates:number}>('/apps/'+encodeURIComponent(id)+'/record','POST',{events:[diagnosticFromResult(result,isTest)]});
export function diagnosticError(error:unknown){
  const code=error instanceof DeveloperApiError?error.code:'UNAVAILABLE';
  if(code==='QUOTA_EXCEEDED')return 'This project reached its event limit, or this browser reached its project limit. Clear old data before retrying.';
  if(code==='NOT_FOUND')return 'This project is unavailable to this browser. Open Developer Studio to choose or create a project.';
  if(code==='RATE_LIMITED')return 'Too many requests. Wait before trying again.';
  if(code==='INVALID_INPUT')return 'Check the project name and HTTPS origin. Do not include a path, query, or trailing slash.';
  return 'Developer diagnostics are temporarily unavailable. Your local signature check can still run without sending diagnostics.';
}
