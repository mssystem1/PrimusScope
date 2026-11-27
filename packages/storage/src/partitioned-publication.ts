import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  AddressSchema, DecimalStringSchema, FinanceEventKindSchema, HashSchema, IdentifierSchema,
  IsoTimestampSchema, NetworkEventKindSchema, StrategyFlowSchema,
} from '@primusscope/api-schema';
import { z } from 'zod';
import { compactPublication, expandPublication } from './compact-publication';
import { StorageError } from './errors';
import { MAX_BLOB_PUBLICATION_BYTES, validatePublication, type HostedPublication } from './publication';

export const PARTITION_ROWS = 2000;
export const MAX_PARTITION_BYTES = 4_000_000;

const KINDS = ['finance', 'network', 'strategyFlows'] as const;
const ARCHIVE_VERSION = 'primusscope-archive-v1';
export type PartitionKind = typeof KINDS[number];

const PartitionRefSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  count: z.literal(PARTITION_ROWS),
  rawBytes: z.number().int().min(1).max(MAX_PARTITION_BYTES),
});

export type PartitionRef = { sha256: string; count: number; rawBytes: number };
export type PartitionReferences = Record<PartitionKind, PartitionRef[]>;
export const PartitionReferencesSchema = z.strictObject({
  finance: z.array(PartitionRefSchema).max(50),
  network: z.array(PartitionRefSchema).max(50),
  strategyFlows: z.array(PartitionRefSchema).max(10),
});

// Match the existing compact-event encoding. Each archive carries the context
// needed to reconstruct the compact rows without consulting a mutable root.
const FinanceRow = z.tuple([
  IdentifierSchema.nullable(), AddressSchema, DecimalStringSchema, HashSchema, HashSchema,
  DecimalStringSchema, IsoTimestampSchema.nullable(), FinanceEventKindSchema, DecimalStringSchema,
]);
const NetworkRow = z.tuple([
  IdentifierSchema.nullable(), DecimalStringSchema, HashSchema, HashSchema, DecimalStringSchema,
  IsoTimestampSchema.nullable(), NetworkEventKindSchema, HashSchema.nullable(), AddressSchema.nullable(),
]);
const FinanceContext = z.strictObject({ sourceId: IdentifierSchema });
const NetworkContext = z.strictObject({ sourceId: IdentifierSchema, taskContract: AddressSchema });
const StrategyContext = z.strictObject({ vaultAddress: AddressSchema });
const PartitionDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(ARCHIVE_VERSION), kind: z.literal('finance'),
    context: FinanceContext, rows: z.array(FinanceRow).length(PARTITION_ROWS),
  }),
  z.strictObject({
    schemaVersion: z.literal(ARCHIVE_VERSION), kind: z.literal('network'),
    context: NetworkContext, rows: z.array(NetworkRow).length(PARTITION_ROWS),
  }),
  z.strictObject({
    schemaVersion: z.literal(ARCHIVE_VERSION), kind: z.literal('strategyFlows'),
    context: StrategyContext, rows: z.array(StrategyFlowSchema).length(PARTITION_ROWS),
  }),
]);
export type PartitionData = z.infer<typeof PartitionDataSchema>;

const TailSchema = z.looseObject({
  snapshot: z.looseObject({
    finance: z.looseObject({
      coverage: z.looseObject({ sourceId: IdentifierSchema }),
      events: z.array(FinanceRow).max(PARTITION_ROWS - 1),
      strategy: z.looseObject({
        vaultAddress: AddressSchema,
        flows: z.array(StrategyFlowSchema).max(PARTITION_ROWS - 1),
      }).optional(),
    }),
    network: z.looseObject({
      coverage: z.looseObject({ sourceId: IdentifierSchema }),
      taskContract: AddressSchema,
      events: z.array(NetworkRow).max(PARTITION_ROWS - 1),
    }),
  }),
});

type ArchiveUpload = { kind: PartitionKind; ref: PartitionRef; body: Uint8Array };

function digest(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex');
}

function archiveBytes(data: PartitionData): Buffer {
  return Buffer.from(JSON.stringify(data));
}

function unavailable(): never {
  throw new StorageError('SOURCE_UNAVAILABLE');
}

function partitionedBytes(tail: unknown, references: PartitionReferences): number {
  let bytes = Buffer.byteLength(JSON.stringify(tail));
  for (const kind of KINDS) {
    for (const ref of references[kind]) bytes += ref.rawBytes;
  }
  return bytes;
}

/** Plan archives from a publication already checked by validatePublication. */
export function planPartitionedPublication(publication: HostedPublication): {
  tail: unknown;
  references: PartitionReferences;
  uploads: ArchiveUpload[];
} {
  const tail = compactPublication(publication);
  const { finance, network } = tail.snapshot;
  const references: PartitionReferences = { finance: [], network: [], strategyFlows: [] };
  const uploads: ArchiveUpload[] = [];

  function planRows<Row>(rows: Row[], partition: (rows: Row[]) => unknown): Row[] {
    const archived = rows.length - rows.length % PARTITION_ROWS;
    for (let offset = 0; offset < archived; offset += PARTITION_ROWS) {
      const data = PartitionDataSchema.parse(partition(rows.slice(offset, offset + PARTITION_ROWS)));
      const raw = archiveBytes(data);
      if (raw.byteLength > MAX_PARTITION_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
      const body = gzipSync(raw);
      if (body.byteLength > MAX_PARTITION_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
      const ref = { sha256: digest(raw), count: data.rows.length, rawBytes: raw.byteLength };
      references[data.kind].push(ref);
      uploads.push({ kind: data.kind, ref, body });
    }
    return rows.slice(archived);
  }

  finance.events = planRows(finance.events, rows => ({
    schemaVersion: ARCHIVE_VERSION, kind: 'finance', context: { sourceId: finance.coverage.sourceId }, rows,
  }));
  network.events = planRows(network.events, rows => ({
    schemaVersion: ARCHIVE_VERSION, kind: 'network',
    context: { sourceId: network.coverage.sourceId, taskContract: network.taskContract }, rows,
  }));
  if (finance.strategy) {
    const { strategy } = finance;
    finance.strategy = {
      ...strategy,
      flows: planRows(strategy.flows, rows => ({
        schemaVersion: ARCHIVE_VERSION, kind: 'strategyFlows', context: { vaultAddress: strategy.vaultAddress }, rows,
      })),
    };
  }
  if (partitionedBytes(tail, references) > MAX_BLOB_PUBLICATION_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
  return { tail, references, uploads };
}

export function decodePartition(kind: PartitionKind, ref: PartitionRef, body: Uint8Array): PartitionData {
  if (!PartitionRefSchema.safeParse(ref).success || body.byteLength > MAX_PARTITION_BYTES) unavailable();
  try {
    const raw = gunzipSync(body, { maxOutputLength: ref.rawBytes });
    if (raw.byteLength !== ref.rawBytes || digest(raw) !== ref.sha256) unavailable();
    const data = PartitionDataSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    if (data.kind !== kind || data.rows.length !== ref.count || !raw.equals(archiveBytes(data))) unavailable();
    return data;
  } catch {
    return unavailable();
  }
}

export function restorePartitionedPublication(
  tail: unknown, references: PartitionReferences, parts: Record<PartitionKind, PartitionData[]>,
): HostedPublication {
  try {
    const refs = PartitionReferencesSchema.parse(references);
    const packed = TailSchema.parse(tail);
    if (partitionedBytes(packed, refs) > MAX_BLOB_PUBLICATION_BYTES) unavailable();
    for (const kind of KINDS) {
      if (refs[kind].length !== parts[kind].length) unavailable();
    }

    const { finance, network } = packed.snapshot;
    const strategyFlows: NonNullable<HostedPublication['snapshot']['finance']['strategy']>['flows'] = [];
    const financeRows: z.infer<typeof FinanceRow>[] = [];
    const networkRows: z.infer<typeof NetworkRow>[] = [];
    for (const kind of KINDS) {
      for (const [index, ref] of refs[kind].entries()) {
        const part = parts[kind][index];
        if (!part || part.kind !== kind || part.rows.length !== ref.count) unavailable();
        const raw = archiveBytes(part);
        if (raw.byteLength !== ref.rawBytes || digest(raw) !== ref.sha256) unavailable();
        switch (part.kind) {
          case 'finance':
            if (part.context.sourceId !== finance.coverage.sourceId) unavailable();
            financeRows.push(...part.rows);
            break;
          case 'network':
            if (part.context.sourceId !== network.coverage.sourceId || part.context.taskContract !== network.taskContract) unavailable();
            networkRows.push(...part.rows);
            break;
          case 'strategyFlows':
            if (part.context.vaultAddress !== finance.strategy?.vaultAddress) unavailable();
            strategyFlows.push(...part.rows);
            break;
        }
      }
    }
    finance.events = financeRows.concat(finance.events);
    network.events = networkRows.concat(network.events);
    if (finance.strategy) finance.strategy.flows = strategyFlows.concat(finance.strategy.flows);
    return validatePublication(expandPublication(packed), MAX_BLOB_PUBLICATION_BYTES);
  } catch {
    return unavailable();
  }
}
