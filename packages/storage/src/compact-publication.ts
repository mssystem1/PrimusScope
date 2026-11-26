import { z } from 'zod';
import { AddressSchema, DecimalStringSchema, FinanceEventKindSchema, HashSchema,
  IdentifierSchema, IsoTimestampSchema, NetworkEventKindSchema } from '@primusscope/api-schema';
import type { HostedPublication } from './publication';

// Fixed columns avoid repeating field names, provenance and derived IDs in
// every event. Keep an explicit ID override for valid noncanonical seed IDs.
const id = IdentifierSchema.nullable(), time = IsoTimestampSchema.nullable();
const FinanceRow = z.tuple([id, AddressSchema, DecimalStringSchema, HashSchema, HashSchema,
  DecimalStringSchema, time, FinanceEventKindSchema, DecimalStringSchema]);
const NetworkRow = z.tuple([id, DecimalStringSchema, HashSchema, HashSchema,
  DecimalStringSchema, time, NetworkEventKindSchema, HashSchema.nullable(), AddressSchema.nullable()]);
const provenance = z.object({ sourceId: IdentifierSchema }).passthrough();
const PackedSchema = z.object({ snapshot: z.object({
  finance: z.object({ coverage: provenance, events: z.array(FinanceRow).max(100_000) }).passthrough(),
  network: z.object({ coverage: provenance, taskContract: AddressSchema,
    events: z.array(NetworkRow).max(100_000) }).passthrough(),
}).passthrough() }).passthrough();

export function compactPublication(publication: HostedPublication) {
  const { snapshot } = publication;
  const override = (chain: number, event: HostedPublication['snapshot']['network']['events'][number]
    | HostedPublication['snapshot']['finance']['events'][number]) =>
    event.id === [chain, event.contractAddress, event.transactionHash, event.logIndex].join(':') ? null : event.id;
  return { ...publication, snapshot: { ...snapshot,
    finance: { ...snapshot.finance, events: snapshot.finance.events.map(e => [override(56, e),
      e.contractAddress, e.blockNumber, e.blockHash, e.transactionHash, e.logIndex, e.timestamp, e.kind, e.batchId]) },
    network: { ...snapshot.network, events: snapshot.network.events.map(e => [override(8453, e),
      e.blockNumber, e.blockHash, e.transactionHash, e.logIndex, e.timestamp, e.kind, e.taskId,
      e.contractAddress === snapshot.network.taskContract ? null : e.contractAddress]) },
  } };
}

/** Expansion is followed by full publication/coverage validation and its byte guard. */
export function expandPublication(value: unknown): unknown {
  const packed = PackedSchema.parse(value), { snapshot } = packed;
  return { ...packed, snapshot: { ...snapshot,
    finance: { ...snapshot.finance, events: snapshot.finance.events.map(row => ({
      id: row[0] ?? [56, row[1], row[4], row[5]].join(':'), contractAddress: row[1],
      blockNumber: row[2], blockHash: row[3], transactionHash: row[4], logIndex: row[5],
      timestamp: row[6], sourceId: snapshot.finance.coverage.sourceId, kind: row[7], batchId: row[8],
    })) },
    network: { ...snapshot.network, events: snapshot.network.events.map(row => ({
      id: row[0] ?? [8453, row[8] ?? snapshot.network.taskContract, row[3], row[4]].join(':'),
      contractAddress: row[8] ?? snapshot.network.taskContract, blockNumber: row[1], blockHash: row[2],
      transactionHash: row[3], logIndex: row[4], timestamp: row[5],
      sourceId: snapshot.network.coverage.sourceId, kind: row[6], taskId: row[7],
    })) },
  } };
}
