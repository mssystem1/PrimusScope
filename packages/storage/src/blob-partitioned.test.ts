import { gunzipSync } from 'node:zlib';
import { FinanceStrategySchema, ObservationSetSchema, type ObservationSet } from '@primusscope/api-schema';
import { describe, expect, it } from 'vitest';
import recorded from '../../../data/observations/current.json';
import strategyBaseline from '../../../data/strategy/unitas-history.json';
import { BlobPublicationStore, type BlobCASClient, type BlobPublicationStoreOptions } from './blob';
import { PARTITION_ROWS } from './partitioned-publication';
import { MAX_BLOB_PUBLICATION_BYTES, validatePublication } from './publication';

const ROOT = 'primusscope/current-v1.json';
const ARCHIVE_PREFIX = 'primusscope/archive-v1/';
const V1 = 'primusscope-publication-v1';
const V2 = 'primusscope-publication-v2';

class PreconditionFailed extends Error {
  constructor() {
    super('Precondition failed.');
    this.name = 'BlobPreconditionFailedError';
  }
}

class MultiCAS implements BlobCASClient {
  private serial = 0;
  readonly objects = new Map<string, { etag: string; bytes: Uint8Array }>();
  readonly reads: string[] = [];
  readonly putAttempts: string[] = [];
  readonly writes: string[] = [];
  beforePut?: (pathname: string) => void;
  canRead?: (pathname: string, token?: string) => boolean;

  async get(pathname: string, options: { token?: string }) {
    this.reads.push(pathname);
    if (this.canRead && !this.canRead(pathname, options.token)) return null;
    const object = this.objects.get(pathname);
    if (!object) return null;
    const { etag, bytes } = object;
    return { etag, stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice());
        controller.close();
      },
    }) };
  }

  async put(pathname: string, body: Uint8Array, options: { allowOverwrite?: boolean; ifMatch?: string }) {
    this.putAttempts.push(pathname);
    this.beforePut?.(pathname);
    const existing = this.objects.get(pathname);
    if (options.ifMatch !== undefined && (existing?.etag !== options.ifMatch || options.allowOverwrite !== true)) {
      throw new PreconditionFailed();
    }
    if (existing && options.allowOverwrite !== true) throw new Error('Object already exists.');
    if (pathname.startsWith(ARCHIVE_PREFIX) && options.allowOverwrite === true) {
      throw new Error('Archive objects must be immutable.');
    }
    const etag = String(++this.serial);
    this.objects.set(pathname, { etag, bytes: body.slice() });
    this.writes.push(pathname);
    return { etag };
  }

  root() {
    return this.objects.get(ROOT)?.bytes.slice();
  }

  rootVersion(): string {
    const bytes = this.root()!;
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    return JSON.parse(Buffer.from(raw).toString('utf8')).schemaVersion;
  }
}

function events<Event extends ObservationSet['network']['events'][number] | ObservationSet['finance']['events'][number]>(
  source: Event, chainId: 56 | 8453, count: number,
): Event[] {
  return Array.from({ length: count }, (_, index) => {
    const contractAddress = index === 0 ? '0x' + source.contractAddress.slice(2).toUpperCase() : source.contractAddress;
    const transactionHash = '0x' + index.toString(16).padStart(64, '0');
    const logIndex = String(index);
    const id = index === 1 ? 'seed:custom-id' : [chainId, contractAddress, transactionHash, logIndex].join(':');
    return { ...source, id, contractAddress, transactionHash, logIndex };
  });
}

function publication(networkCount: number, allHistory = false) {
  const snapshot = ObservationSetSchema.parse(recorded);
  snapshot.network.events = events(snapshot.network.events[0]!, 8453, networkCount);
  if (allHistory) {
    snapshot.finance.events = events(snapshot.finance.events[0]!, 56, PARTITION_ROWS + 1);
    snapshot.finance.strategy = FinanceStrategySchema.parse(strategyBaseline);
  }
  return validatePublication({
    schemaVersion: '1.0.0', snapshot,
    checkpoints: (['finance', 'network'] as const).map(domain => {
      const { chainId, fromBlock, toBlock, toTime, observedAt } = snapshot[domain].coverage;
      return {
        domain, chainId, fromBlock, toBlock, toTime, observedAt,
        nextBlock: String(BigInt(toBlock) + 1n), blockHash: '0x' + '11'.repeat(32),
        quarantined: false, nextRetryAt: null, lastAttemptAt: null, lastSuccessAt: null,
        lastOutcome: null, lastErrorCode: null, targetFinalizedBlock: null, sourceAsOf: null,
        lagBlocks: null, asObservedAt: null, retryAfterSeconds: null,
      };
    }),
    collector: { mode: 'manual', intervalMinutes: null, runUrl: null },
  }, MAX_BLOB_PUBLICATION_BYTES);
}

function store(transport: MultiCAS, options?: Omit<BlobPublicationStoreOptions, 'transport'>) {
  return new BlobPublicationStore({ transport, ...options });
}

describe('partitioned Blob publication protocol', () => {
  it('migrates existing history only on publish and preserves v2 for writers with the default option', async () => {
    const transport = new MultiCAS(), seed = publication(PARTITION_ROWS + 1, true);
    const previousWriter = store(transport);
    await expect(previousWriter.initialize(seed)).resolves.toBe(true);
    expect(transport.rootVersion()).toBe(V1);
    expect(transport.writes).toEqual([ROOT]);

    const nextWriter = store(transport, { partitionedWrites: true });
    const token = (await nextWriter.acquireLease('partition-upgrade'))!;
    expect(transport.rootVersion()).toBe(V1);
    expect(transport.writes).toEqual([ROOT, ROOT]);
    await expect(nextWriter.publish(token, '0', seed)).resolves.toBe('1');
    expect(transport.rootVersion()).toBe(V2);
    const archives = transport.writes.filter(path => path !== ROOT);
    expect(archives).toHaveLength(4);
    expect(archives.filter(path => path.includes('/strategyFlows/'))).toHaveLength(2);
    for (const path of archives) expect(path).toMatch(/^primusscope\/archive-v1\/(finance|network|strategyFlows)\/[a-f0-9]{64}\.json\.gz$/);
    const reader = store(transport, { readOnly: true });
    await expect(reader.read()).resolves.toEqual({ revision: '1', publication: seed });

    const lease = (await previousWriter.acquireLease('compatibility-writer'))!;
    const attempts = transport.putAttempts.length;
    const next = { ...seed, collector: { ...seed.collector, mode: 'scheduled' as const, intervalMinutes: 60 } };
    await expect(previousWriter.publish(lease, '1', next)).resolves.toBe('2');
    expect(transport.putAttempts.slice(attempts)).toEqual([ROOT]);
    expect(transport.rootVersion()).toBe(V2);
    await expect(reader.read()).resolves.toEqual({ revision: '2', publication: next });
  });

  it('adds one archive when an inline tail fills and replaces an archive after a correction', async () => {
    const transport = new MultiCAS(), writer = store(transport, { partitionedWrites: true });
    const seed = publication(PARTITION_ROWS - 1), full = publication(PARTITION_ROWS);
    await expect(writer.initialize(seed)).resolves.toBe(true);
    expect(transport.rootVersion()).toBe(V2);
    expect(transport.writes).toEqual([ROOT]);

    let token = (await writer.acquireLease('lease-only'))!;
    await writer.releaseLease(token);
    expect(transport.putAttempts).toEqual([ROOT, ROOT, ROOT]);
    token = (await writer.acquireLease('archive-boundary'))!;
    const firstPublish = transport.putAttempts.length;
    await expect(writer.publish(token, '0', full)).resolves.toBe('1');
    const firstArchive = transport.putAttempts[firstPublish]!;
    expect(firstArchive).toMatch(/^primusscope\/archive-v1\/network\//);
    expect(transport.putAttempts.slice(firstPublish)).toEqual([firstArchive, ROOT]);

    const corrected = structuredClone(full);
    corrected.snapshot.network.events[0]!.id = 'corrected:seed';
    token = (await writer.acquireLease('corrected-history'))!;
    const secondPublish = transport.putAttempts.length;
    await expect(writer.publish(token, '1', corrected)).resolves.toBe('2');
    const correctedArchive = transport.putAttempts[secondPublish]!;
    expect(correctedArchive).toMatch(/^primusscope\/archive-v1\/network\//);
    expect(correctedArchive).not.toBe(firstArchive);
    expect(transport.putAttempts.slice(secondPublish)).toEqual([correctedArchive, ROOT]);
    expect(transport.objects.has(firstArchive)).toBe(true);
    await expect(store(transport, { readOnly: true }).read()).resolves.toEqual({ revision: '2', publication: corrected });
  });

  it('preserves root bytes after upload or CAS failure and reuses the staged archive on retry', async () => {
    const transport = new MultiCAS(), writer = store(transport, { partitionedWrites: true });
    await writer.initialize(publication(PARTITION_ROWS - 1));
    const token = (await writer.acquireLease('retry-archive'))!;
    const proposed = publication(PARTITION_ROWS);
    const original = transport.root();
    const initialWrites = transport.writes.length;

    transport.beforePut = path => { if (path !== ROOT) throw new Error('Upload failed.'); };
    await expect(writer.publish(token, '0', proposed)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(transport.root()).toEqual(original);
    expect(transport.writes).toHaveLength(initialWrites);

    transport.beforePut = path => { if (path === ROOT) throw new PreconditionFailed(); };
    await expect(writer.publish(token, '0', proposed)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    expect(transport.root()).toEqual(original);
    const staged = transport.writes.at(-1)!;
    expect(staged).toMatch(/^primusscope\/archive-v1\/network\//);
    expect(transport.writes).toHaveLength(initialWrites + 1);

    transport.beforePut = undefined;
    await expect(store(transport, { partitionedWrites: true }).publish(token, '0', proposed)).resolves.toBe('1');
    expect(transport.writes.slice(initialWrites)).toEqual([staged, ROOT]);
    await expect(store(transport, { readOnly: true }).read()).resolves.toEqual({ revision: '1', publication: proposed });
  });

  it('fences a publish whose lease expires while the upload is in flight', async () => {
    let now = 1_800_000_000_000;
    const transport = new MultiCAS(), writer = store(transport, { partitionedWrites: true, clock: () => now });
    await writer.initialize(publication(PARTITION_ROWS - 1));
    const token = (await writer.acquireLease('expiring-writer', 30))!;
    const original = transport.root(), attempt = transport.putAttempts.length;
    transport.beforePut = path => { if (path !== ROOT) now += 30_000; };

    await expect(writer.publish(token, '0', publication(PARTITION_ROWS))).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    expect(transport.root()).toEqual(original);
    expect(transport.putAttempts.slice(attempt)).toHaveLength(1);
    expect(transport.putAttempts.at(-1)).toMatch(/^primusscope\/archive-v1\/network\//);
  });

  it('rejects missing or corrupted archive reads while permitting metadata-only lease release', async () => {
    const initial = new MultiCAS(), seed = publication(PARTITION_ROWS);
    await store(initial, { partitionedWrites: true }).initialize(seed);
    await expect(store(initial, { readOnly: true }).read()).resolves.toEqual({ revision: '0', publication: seed });
    const archive = initial.writes.find(path => path !== ROOT)!;
    const transport = new MultiCAS();
    for (const [path, data] of initial.objects) transport.objects.set(path, data);
    const writer = store(transport), lease = (await writer.acquireLease('corrupt-archive'))!;

    const reader = store(transport, { readOnly: true, token: 'test-cold-reader' });
    transport.objects.delete(archive);
    await expect(reader.read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    transport.objects.set(archive, { etag: 'corrupt', bytes: Uint8Array.of(1, 2, 3) });
    await expect(reader.read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(transport.reads).toContain(archive);
    const afterRead = transport.reads.length;
    await expect(writer.revision()).resolves.toBe('0');
    await expect(writer.releaseLease(lease)).resolves.toBeUndefined();
    expect(transport.reads.slice(afterRead)).toEqual([ROOT, ROOT]);
    expect(transport.putAttempts).toEqual([ROOT, ROOT]);
    await expect(writer.acquireLease('replacement')).resolves.toEqual(expect.any(String));
  });

  it('does not share cached archive data across Blob credentials', async () => {
    const transport = new MultiCAS(), seed = publication(PARTITION_ROWS);
    const authorized = 'test-archive-reader';
    await store(transport, { partitionedWrites: true, token: authorized }).initialize(seed);
    transport.canRead = (path, token) => path === ROOT || token === authorized;

    await expect(store(transport, { readOnly: true, token: authorized }).read()).resolves.toEqual({ revision: '0', publication: seed });
    const afterFirstRead = transport.reads.length;
    await expect(store(transport, { readOnly: true, token: authorized }).read()).resolves.toEqual({ revision: '0', publication: seed });
    expect(transport.reads.slice(afterFirstRead)).toEqual([ROOT]);
    await expect(store(transport, { readOnly: true, token: 'test-root-reader' }).read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });

    const otherStore = new MultiCAS();
    otherStore.objects.set(ROOT, transport.objects.get(ROOT)!);
    await expect(store(otherStore, { readOnly: true, token: authorized }).read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
});
