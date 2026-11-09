import { z } from 'zod';
import { DecimalStringSchema, HashSchema, IsoTimestampSchema, ObservationSetSchema } from '@primusscope/api-schema';
import { StorageError } from './errors';

const time = IsoTimestampSchema.nullable();
export const CheckpointPublicationSchema = z.object({
  domain: z.enum(['finance', 'network']), chainId: z.union([z.literal(56), z.literal(8453)]),
  fromBlock: DecimalStringSchema, toBlock: DecimalStringSchema, nextBlock: DecimalStringSchema,
  blockHash: HashSchema, toTime: IsoTimestampSchema, observedAt: IsoTimestampSchema,
  quarantined: z.boolean(), nextRetryAt: time,
  lastAttemptAt: time, lastSuccessAt: time, lastOutcome: z.enum(['idle', 'advanced', 'failed']).nullable(),
  lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  targetFinalizedBlock: DecimalStringSchema.nullable(), sourceAsOf: time,
  lagBlocks: DecimalStringSchema.nullable(), asObservedAt: time,
  retryAfterSeconds: z.number().int().min(0).max(86400).nullable(),
}).strict();

export const HostedPublicationSchema = z.object({
  schemaVersion: z.literal('1.0.0'), snapshot: ObservationSetSchema,
  checkpoints: z.array(CheckpointPublicationSchema).length(2),
  collector: z.object({
    mode: z.enum(['manual', 'scheduled']), intervalMinutes: z.number().int().min(5).max(1440).nullable(),
    provider: z.enum(['manual', 'vercel_cron']).optional(),
    runUrl: z.string().regex(/^https:\/\/github\.com\/mssystem1\/PrimusScope\/actions\/runs\/[0-9]+$/).nullable(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if ((value.collector.mode === 'scheduled') !== (value.collector.intervalMinutes !== null)
    || (value.collector.provider === 'vercel_cron' && value.collector.mode !== 'scheduled')
    || (value.collector.provider === 'manual' && value.collector.mode !== 'manual')) {
    context.addIssue({ code: 'custom', message: 'Invalid collection schedule.' });
  }
  for (const domain of ['finance', 'network'] as const) {
    const matches = value.checkpoints.filter(c => c.domain === domain);
    if (matches.length !== 1) { context.addIssue({ code: 'custom', message: 'Invalid domain checkpoint.' }); continue; }
    const checkpoint = matches[0]!;
    if ((checkpoint.targetFinalizedBlock === null) !== (checkpoint.sourceAsOf === null)
      || (checkpoint.targetFinalizedBlock === null) !== (checkpoint.asObservedAt === null)) {
      context.addIssue({ code: 'custom', message: 'Incomplete head observation.' });
    }
    const coverage = value.snapshot[domain].coverage;
    if (![checkpoint.toBlock, checkpoint.nextBlock, ...(checkpoint.targetFinalizedBlock === null ? [] : [checkpoint.targetFinalizedBlock])]
      .every(v => DecimalStringSchema.safeParse(v).success)) continue;
    if (checkpoint.chainId !== coverage.chainId || checkpoint.fromBlock !== coverage.fromBlock
      || checkpoint.toBlock !== coverage.toBlock || checkpoint.toTime !== coverage.toTime
      || checkpoint.observedAt !== coverage.observedAt
      || BigInt(checkpoint.nextBlock) !== BigInt(checkpoint.toBlock) + 1n) {
      context.addIssue({ code: 'custom', message: 'Checkpoint and publication coverage differ.' });
    }
    const lag = checkpoint.targetFinalizedBlock === null ? null :
      String(BigInt(checkpoint.targetFinalizedBlock) > BigInt(checkpoint.toBlock)
        ? BigInt(checkpoint.targetFinalizedBlock) - BigInt(checkpoint.toBlock) : 0n);
    if (lag !== checkpoint.lagBlocks) context.addIssue({ code: 'custom', message: 'Invalid recorded head lag.' });
  }
});
export type HostedPublication = z.infer<typeof HostedPublicationSchema>;
export const MAX_PUBLICATION_BYTES = 16_000_000;

export function validatePublication(value: unknown): HostedPublication {
  const parsed = HostedPublicationSchema.safeParse(value);
  if (!parsed.success) throw new StorageError('INVALID_PUBLICATION');
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_PUBLICATION_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
  return parsed.data;
}
