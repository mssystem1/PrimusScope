import {z} from 'zod';
import {SDK_INFO,DiagnosticEventSchema,type DiagnosticEvent,type DiagnosticCode} from '@primusscope/api-schema/sdk-diagnostics';
export * from '@primusscope/api-schema/sdk-diagnostics';

export const MAX_ATTESTATION_BYTES=65536;
export type CheckStatus='passed'|'failed'|'not_checked'|'unsupported';
export type Check={status:CheckStatus;code:string};
export type InspectionPolicy={recipient:string;requestUrl:string;requestMethod:string;additionParams:string;timestampUnit:'unspecified'|'seconds'|'milliseconds';maxAgeSeconds:number};
export const emptyInspectionPolicy:InspectionPolicy={recipient:'',requestUrl:'',requestMethod:'',additionParams:'',timestampUnit:'unspecified',maxAgeSeconds:3600};
export type InspectionResult={sdk:typeof SDK_INFO;outcome:'signer_matched'|'rejected'|'unsupported'|'error';
  checks:{format:Check;signature:Check;sdkSigner:Check;recipient:Check;request:Check;context:Check;freshness:Check};
  checkedAt:string;durationMs:number;sdkInvoked:boolean;errorCode:DiagnosticCode};

const boundedString=(size:number)=>z.string().max(size);
const AddressSchema=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint64=z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),z.string().regex(/^(0|[1-9][0-9]{0,19})$/)]).refine(value=>BigInt(value)<=18446744073709551615n);
export const PageAttestationSchema=z.object({recipient:AddressSchema,
  request:z.object({url:boundedString(4096),header:boundedString(16384),method:boundedString(16),body:boundedString(16384)}).strict(),
  reponseResolve:z.array(z.object({keyName:boundedString(256),parseType:boundedString(64),parsePath:boundedString(2048)}).strict()).max(32),
  data:boundedString(16384),attConditions:boundedString(8192),timestamp:uint64,additionParams:boundedString(8192),
  attestors:z.array(z.object({attestorAddr:AddressSchema,url:boundedString(4096)}).strict()).min(1).max(1),
  signatures:z.array(z.string().regex(/^0x[0-9a-fA-F]{128}(1[bBcC])$/)).length(1)}).strict();
export type PageAttestation=z.infer<typeof PageAttestationSchema>;
export const InspectionPolicySchema=z.object({recipient:z.union([z.literal(''),AddressSchema]),requestUrl:boundedString(4096),requestMethod:boundedString(16),additionParams:boundedString(8192),timestampUnit:z.enum(['unspecified','seconds','milliseconds']),maxAgeSeconds:z.number().int().min(1).max(2592000)}).strict();
export function diagnosticFromResult(result:InspectionResult,isTest=false):DiagnosticEvent{
  return DiagnosticEventSchema.parse({eventId:crypto.randomUUID(),sdk:SDK_INFO.package,version:SDK_INFO.version,operation:'verifyAttestation',durationMs:Math.round(result.durationMs*100)/100,outcome:result.outcome,errorCode:result.errorCode,runtime:'browser',sdkInvoked:result.sdkInvoked,isTest});
}
