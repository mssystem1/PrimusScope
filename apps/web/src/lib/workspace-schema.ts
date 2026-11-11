import {z} from 'zod';
import {DecimalStringSchema,IsoTimestampSchema,Sha256Schema} from '@primusscope/api-schema';
export const WatchRequestSchema=z.object({items:z.array(z.object({id:z.string().min(1).max(256),href:z.string().min(1).max(512)}).strict()).max(50)}).strict().refine(value=>new Set(value.items.map(item=>item.id)).size===value.items.length);
export const WatchObservationSchema=z.object({id:z.string().min(1).max(256),href:z.string().max(512),kind:z.enum(['task','batch','vault','view']),domain:z.enum(['finance','network']),availability:z.enum(['available','unavailable']),reason:z.enum(['NOT_FOUND','UNSUPPORTED_VIEW','INCOMPLETE_COVERAGE']).nullable(),scopeKey:Sha256Schema.nullable(),contentHash:Sha256Schema.nullable(),eventCount:z.number().int().nonnegative().nullable(),state:z.string().max(80).nullable(),stateSampleBlock:DecimalStringSchema.nullable(),sourceAsOf:IsoTimestampSchema.nullable(),coverage:z.object({fromBlock:DecimalStringSchema,toBlock:DecimalStringSchema,complete:z.boolean()}).strict().nullable()}).strict();
export type WatchObservation=z.infer<typeof WatchObservationSchema>;
export const WatchResponseSchema=z.object({snapshotId:Sha256Schema,checkedAt:IsoTimestampSchema,mode:z.enum(['recorded_observations','indexed_observations']),items:z.array(WatchObservationSchema).max(50)}).strict();
export const WatchBaselineSchema=z.object({reviewedAt:IsoTimestampSchema,observation:WatchObservationSchema}).strict();
export type WatchBaseline=z.infer<typeof WatchBaselineSchema>;
