import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FinanceStrategySchema, ObservationSetSchema } from '@primusscope/api-schema';
import { describe, expect, it } from 'vitest';
import recorded from '../../../data/observations/current.json';
import strategyBaseline from '../../../data/strategy/unitas-history.json';
import { compactPublication } from './compact-publication';
import {
  decodePartition, MAX_PARTITION_BYTES, PARTITION_ROWS, PartitionReferencesSchema,
  planPartitionedPublication, restorePartitionedPublication, type PartitionData, type PartitionKind,
} from './partitioned-publication';
import { MAX_BLOB_PUBLICATION_BYTES, validatePublication } from './publication';

const sourceUnavailable = { code: 'SOURCE_UNAVAILABLE' };

function copyEvents<Event extends { id: string; contractAddress: string; transactionHash: string; logIndex: string }>(
  event: Event, chain: number, count: number,
): Event[] {
  return Array.from({ length: count }, (_, index) => {
    const contractAddress = index === 0 ? '0x' + event.contractAddress.slice(2).toUpperCase() : event.contractAddress;
    const transactionHash = '0x' + index.toString(16).padStart(64, '0');
    const logIndex = String(index);
    const id = index === 1 ? 'retained:custom-id' : [chain, contractAddress, transactionHash, logIndex].join(':');
    return { ...event, id, contractAddress, transactionHash, logIndex };
  });
}

function publication() {
  const snapshot = ObservationSetSchema.parse(recorded);
  snapshot.finance.events = copyEvents(snapshot.finance.events[0]!, 56, PARTITION_ROWS + 1);
  snapshot.network.events = copyEvents(snapshot.network.events[0]!, 8453, 2 * PARTITION_ROWS);
  snapshot.finance.strategy = FinanceStrategySchema.parse(strategyBaseline);
  const checkpoints = (['finance', 'network'] as const).map(domain => {
    const { chainId, fromBlock, toBlock, toTime, observedAt } = snapshot[domain].coverage;
    return {
      domain, chainId, fromBlock, toBlock, toTime, observedAt, nextBlock: String(BigInt(toBlock) + 1n),
      blockHash: '0x' + '11'.repeat(32), quarantined: false, nextRetryAt: null, lastAttemptAt: null,
      lastSuccessAt: null, lastOutcome: null, lastErrorCode: null, targetFinalizedBlock: null,
      sourceAsOf: null, lagBlocks: null, asObservedAt: null, retryAfterSeconds: null,
    };
  });
  return validatePublication({
    schemaVersion: '1.0.0', snapshot, checkpoints,
    collector: { mode: 'manual', intervalMinutes: null, runUrl: null },
  }, MAX_BLOB_PUBLICATION_BYTES);
}

function decodePlan(plan: ReturnType<typeof planPartitionedPublication>): Record<PartitionKind, PartitionData[]> {
  const parts: Record<PartitionKind, PartitionData[]> = { finance: [], network: [], strategyFlows: [] };
  for (const { kind, ref, body } of plan.uploads) parts[kind].push(decodePartition(kind, ref, body));
  return parts;
}

describe('partitioned publication codec', () => {
  it('archives complete chunks and restores all three histories in exact order', () => {
    const seed = publication(), plan = planPartitionedPublication(seed);
    const expectedTail = compactPublication(seed);
    expectedTail.snapshot.finance.events = expectedTail.snapshot.finance.events.slice(PARTITION_ROWS);
    expectedTail.snapshot.network.events = [];
    expectedTail.snapshot.finance.strategy = {
      ...expectedTail.snapshot.finance.strategy!,
      flows: expectedTail.snapshot.finance.strategy!.flows.slice(2 * PARTITION_ROWS),
    };

    expect(plan.references.finance).toHaveLength(1);
    expect(plan.references.network).toHaveLength(2);
    expect(plan.references.strategyFlows).toHaveLength(2);
    expect(plan.tail).toEqual(expectedTail);
    expect(restorePartitionedPublication(plan.tail, plan.references, decodePlan(plan))).toEqual(seed);
  });

  it('replaces the affected reference for a correction without changing a later chunk', () => {
    const seed = publication(), previous = planPartitionedPublication(seed);
    seed.snapshot.network.events[0]!.id = 'corrected:custom-id';
    const next = planPartitionedPublication(seed);

    expect(next.references.network[0]).not.toEqual(previous.references.network[0]);
    expect(next.references.network[1]).toEqual(previous.references.network[1]);
    expect(next.references.finance).toEqual(previous.references.finance);
    expect(next.references.strategyFlows).toEqual(previous.references.strategyFlows);
  });

  it('rejects invalid reference sizes, digests, rows, and archive kinds', () => {
    const plan = planPartitionedPublication(publication());
    const { kind, ref, body } = plan.uploads[0]!;
    expect(() => decodePartition(kind, ref, Uint8Array.of(1, 2, 3))).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(() => decodePartition(kind, { ...ref, sha256: '0'.repeat(64) }, body)).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(() => decodePartition(kind, { ...ref, rawBytes: ref.rawBytes - 1 }, body)).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(() => decodePartition(kind, { ...ref, count: PARTITION_ROWS - 1 }, body)).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(() => decodePartition('network', ref, body)).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(PartitionReferencesSchema.safeParse({
      ...plan.references, finance: [{ ...ref, rawBytes: MAX_PARTITION_BYTES + 1 }],
    }).success).toBe(false);

    const invalid = JSON.parse(gunzipSync(body).toString('utf8'));
    invalid.rows[0][3] = 'invalid-hash';
    const raw = Buffer.from(JSON.stringify(invalid));
    const corruptRef = { ...ref, sha256: createHash('sha256').update(raw).digest('hex'), rawBytes: raw.byteLength };
    expect(() => decodePartition(kind, corruptRef, gzipSync(raw))).toThrowError(expect.objectContaining(sourceUnavailable));
  });

  it('rejects missing or reordered parts and conflicting root context', () => {
    const plan = planPartitionedPublication(publication()), parts = decodePlan(plan);
    expect(() => restorePartitionedPublication(plan.tail, plan.references, {
      ...parts, finance: [],
    })).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(() => restorePartitionedPublication(plan.tail, plan.references, {
      ...parts, network: [...parts.network].reverse(),
    })).toThrowError(expect.objectContaining(sourceUnavailable));

    const tail = structuredClone(plan.tail) as ReturnType<typeof compactPublication>;
    tail.snapshot.network.taskContract = '0x' + tail.snapshot.network.taskContract.slice(2).toUpperCase();
    expect(() => restorePartitionedPublication(tail, plan.references, parts)).toThrowError(expect.objectContaining(sourceUnavailable));
  });

  it('rejects oversized inline tails and unexpected manifest fields', () => {
    const seed = publication(), plan = planPartitionedPublication(seed), parts = decodePlan(plan);
    const tail = structuredClone(plan.tail) as ReturnType<typeof compactPublication>;
    tail.snapshot.network.events = compactPublication(seed).snapshot.network.events.slice(0, PARTITION_ROWS);
    expect(() => restorePartitionedPublication(tail, plan.references, parts)).toThrowError(expect.objectContaining(sourceUnavailable));
    expect(() => restorePartitionedPublication({
      ...(plan.tail as object), unexpected: true,
    }, plan.references, parts)).toThrowError(expect.objectContaining(sourceUnavailable));
  });
});
