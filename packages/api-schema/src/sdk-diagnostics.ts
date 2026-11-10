import {z} from 'zod';
export const SDK_INFO={package:'@primuslabs/zktls-page-core-sdk',version:'0.2.1',
  signer:'0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6',
  integrity:'sha512-KuEP7xPOUzUKsVA3/AATLWmDKXWjgUdlgosZ+A9DExLVUmBrWlr5XVwvS76uIzL9prV5ysQ3eKTCMruMNr8Ozw==',
  method:'PrimusPageCoreTLS.prototype.verifyAttestation',schema:'page-core-0.2.1'} as const;
export const DiagnosticCodeSchema=z.enum(['NONE','UNSUPPORTED_FORMAT','SIGNATURE_REJECTED','SIGNER_MISMATCH','POLICY_MISMATCH','SDK_ERROR','TIMEOUT','CANCELLED']);
export type DiagnosticCode=z.infer<typeof DiagnosticCodeSchema>;
export const DiagnosticEventSchema=z.object({eventId:z.uuid(),sdk:z.literal(SDK_INFO.package),version:z.literal(SDK_INFO.version),operation:z.literal('verifyAttestation'),
  durationMs:z.number().finite().min(0).max(30000),outcome:z.enum(['signer_matched','rejected','unsupported','error','cancelled']),sdkInvoked:z.boolean(),isTest:z.boolean(),
  errorCode:DiagnosticCodeSchema,runtime:z.literal('browser')}).strict();
export type DiagnosticEvent=z.infer<typeof DiagnosticEventSchema>;
export const DiagnosticBatchSchema=z.object({events:z.array(DiagnosticEventSchema).min(1).max(25)}).strict();
export const AppOriginSchema=z.string().max(255).refine(value=>{try{const u=new URL(value);return u.origin===value&&!u.username&&!u.password&&(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));}catch{return false;}},'Use an HTTPS origin, or localhost for development.');
export const RegisterDiagnosticAppSchema=z.object({name:z.string().trim().min(1).max(64),origin:AppOriginSchema,consent:z.literal(true)}).strict();
export type DiagnosticApp={id:string;name:string;origin:string;createdAt:string;expiresAt:string;keyVersion:number};
export type DiagnosticRecord=DiagnosticEvent&{receivedAt:string};
export type DiagnosticAppDetail={app:DiagnosticApp;events:DiagnosticRecord[];retentionDays:7;limit:1000};
