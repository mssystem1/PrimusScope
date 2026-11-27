import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { z } from 'zod';
import { StorageError } from './errors';
import { MAX_BLOB_PUBLICATION_BYTES, validatePublication, type HostedPublication } from './publication';
import { compactPublication, expandPublication } from './compact-publication';
import { MAX_PARTITION_BYTES, PartitionReferencesSchema, decodePartition, planPartitionedPublication,
  restorePartitionedPublication, type PartitionData, type PartitionKind, type PartitionRef } from './partitioned-publication';

const BLOB_PATH = 'primusscope/current-v1.json';
const ARCHIVE_PREFIX = 'primusscope/archive-v1/';
export const MAX_ENVELOPE_BYTES = MAX_BLOB_PUBLICATION_BYTES + 4096;
const MAX_MANIFEST_BYTES = 32_000_000;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
const LeaseSchema = z.object({ token: z.string().uuid(), owner: z.string().regex(OWNER), expiresAt: z.number().int().positive() }).strict();
const LegacyEnvelopeSchema = z.object({
  schemaVersion: z.literal('primusscope-publication-v1'), revision: z.string().regex(REVISION), publication: z.unknown(),
  compression: z.enum(['gzip-base64', 'compact-events-v1']).optional(), lease: LeaseSchema.nullable(),
}).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal('primusscope-publication-v2'), revision: z.string().regex(REVISION), publication: z.unknown(),
  compression: z.literal('partitioned-events-v1'), partitions: PartitionReferencesSchema, lease: LeaseSchema.nullable(),
}).strict();
type Lease = z.infer<typeof LeaseSchema>;
type Wire = z.infer<typeof LegacyEnvelopeSchema> | z.infer<typeof ManifestSchema>;
type Root = { wire: Wire; etag: string };
type State = { revision: string; publication: HostedPublication };
type ReadBlob = { etag: string; stream: ReadableStream<Uint8Array> } | null;
export interface BlobCASClient {
  get(pathname: string, options: { access: 'private'; useCache: boolean; token?: string }): Promise<ReadBlob>;
  put(pathname: string, body: Uint8Array, options: {
    access: 'private'; allowOverwrite?: boolean; ifMatch?: string; token?: string;
  }): Promise<{ etag: string }>;
}
export interface BlobPublicationStoreOptions {
  token?: string;
  readOnly?: boolean;
  /** Starts migration from v1; every writer preserves an existing v2 layout. */
  partitionedWrites?: boolean;
  /** Read-only roots may use the CDN; archives are immutable and always cacheable. */
  useCache?: boolean;
  clock?: () => number;
  transport?: BlobCASClient;
}
const sdkTransport: BlobCASClient = {
  async get(pathname, options) {
    const result = await get(pathname, { access: options.access, useCache: options.useCache,
      token: options.token, headers: { 'Accept-Encoding': 'identity' }, abortSignal: AbortSignal.timeout(6000) });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new StorageError('SOURCE_UNAVAILABLE');
    if (!options.useCache && result.blob.etag.startsWith('W/')) {
      await result.stream.cancel(); throw new StorageError('SOURCE_UNAVAILABLE');
    }
    return { etag: result.blob.etag, stream: result.stream };
  },
  async put(pathname, body, options) {
    const result = await put(pathname, Buffer.from(body), { access: options.access,
      allowOverwrite: options.allowOverwrite, ifMatch: options.ifMatch, token: options.token,
      addRandomSuffix: false, cacheControlMaxAge: pathname.startsWith(ARCHIVE_PREFIX) ? 31_536_000 : 60,
      contentType: 'application/octet-stream', abortSignal: AbortSignal.timeout(20_000) });
    return { etag: result.etag };
  },
};

// A new store is created on each web refresh. Cache only verified immutable parts,
// with independent byte/entry bounds and credential/transport isolation.
const archiveCache = new Map<string, { data: PartitionData; bytes: number }>();
const archiveInFlight = new Map<string, Promise<PartitionData>>();
const transportIds = new WeakMap<BlobCASClient, number>();
let nextTransportId = 0, archiveCacheBytes = 0;
const CACHE_BYTES = 16_000_000, CACHE_ENTRIES = 64;
function cachePut(key: string, data: PartitionData, bytes: number) {
  const previous = archiveCache.get(key);
  if (previous) { archiveCacheBytes -= previous.bytes; archiveCache.delete(key); }
  if (bytes > CACHE_BYTES) return;
  archiveCache.set(key, { data, bytes }); archiveCacheBytes += bytes;
  while (archiveCache.size > CACHE_ENTRIES || archiveCacheBytes > CACHE_BYTES) {
    const oldest = archiveCache.keys().next().value!;
    archiveCacheBytes -= archiveCache.get(oldest)!.bytes; archiveCache.delete(oldest);
  }
}
function archivePath(kind: PartitionKind, ref: PartitionRef) { return `${ARCHIVE_PREFIX}${kind}/${ref.sha256}.json.gz`; }
function isPreconditionFailure(error: unknown): boolean {
  if (error instanceof BlobPreconditionFailedError) return true;
  const value = error as { name?: unknown; code?: unknown } | null;
  return value?.name === 'BlobPreconditionFailedError' || value?.code === 'precondition_failed';
}
async function readBytes(stream: ReadableStream<Uint8Array>, maximum = MAX_ENVELOPE_BYTES): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new StorageError('CAPACITY_EXCEEDED'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function decodeRoot(bytes: Uint8Array, etag: string): Root {
  try {
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_ENVELOPE_BYTES }) : bytes;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!etag) throw new Error();
    if (value?.schemaVersion === 'primusscope-publication-v2') {
      if (raw.byteLength > MAX_MANIFEST_BYTES) throw new Error();
      const wire = ManifestSchema.parse(value);
      const total = Buffer.byteLength(JSON.stringify(wire.publication))
        + Object.values(wire.partitions).flat().reduce((sum, ref) => sum + ref.rawBytes, 0);
      if (total > MAX_BLOB_PUBLICATION_BYTES) throw new Error();
      return { wire, etag };
    }
    return { wire: LegacyEnvelopeSchema.parse(value), etag };
  } catch { throw new StorageError('SOURCE_UNAVAILABLE'); }
}
function legacyWire(revision: string, publication: HostedPublication, lease: Lease | null): Wire {
  return { schemaVersion: 'primusscope-publication-v1', revision,
    publication: compactPublication(publication), compression: 'compact-events-v1', lease };
}

/** Atomic current root plus content-addressed immutable archive partitions. */
export class BlobPublicationStore {
  readonly publicationMaxBytes = MAX_BLOB_PUBLICATION_BYTES;
  private readonly client: BlobCASClient;
  private readonly now: () => number;
  private readonly readOnly: boolean;
  private readonly readCache: boolean;
  private readonly partitionedWrites: boolean;
  private readonly token?: string;
  private readonly cacheNamespace: string;
  private ownedLease: Lease | null = null;
  private ownedState: State | null = null;
  constructor(options: BlobPublicationStoreOptions = {}) {
    this.client = options.transport ?? sdkTransport; this.now = options.clock ?? Date.now;
    this.readOnly = options.readOnly ?? false; this.readCache = this.readOnly ? (options.useCache ?? true) : false;
    this.partitionedWrites = options.partitionedWrites ?? false; this.token = options.token ?? process.env.BLOB_READ_WRITE_TOKEN;
    if (!transportIds.has(this.client)) transportIds.set(this.client, ++nextTransportId);
    const digest = createHash('sha256').update(this.token ?? '').digest('hex');
    this.cacheNamespace = transportIds.get(this.client) + ':' + digest + ':';
  }
  private writable() { if (this.readOnly) throw new StorageError('READ_ONLY'); }
  private async root(): Promise<Root | null> {
    try {
      const blob = await this.client.get(BLOB_PATH, { access: 'private', useCache: this.readCache, token: this.token });
      return blob ? decodeRoot(await readBytes(blob.stream), blob.etag) : null;
    } catch (error) { if (error instanceof StorageError) throw error; throw new StorageError('DATABASE_UNAVAILABLE'); }
  }
  private async archive(kind: PartitionKind, ref: PartitionRef, origin = false): Promise<PartitionData> {
    const key = this.cacheNamespace + kind + ':' + ref.sha256 + ':' + ref.rawBytes;
    if (!origin) {
      const cached = archiveCache.get(key);
      if (cached) { archiveCache.delete(key); archiveCache.set(key, cached); return cached.data; }
      const pending = archiveInFlight.get(key); if (pending) return pending;
    }
    const promise = (async () => {
      const blob = await this.client.get(archivePath(kind, ref), { access: 'private', useCache: !origin, token: this.token });
      if (!blob) throw new StorageError('SOURCE_UNAVAILABLE');
      const data = decodePartition(kind, ref, await readBytes(blob.stream, MAX_PARTITION_BYTES));
      cachePut(key, data, ref.rawBytes); return data;
    })();
    if (!origin) archiveInFlight.set(key, promise);
    try { return await promise; } finally { if (archiveInFlight.get(key) === promise) archiveInFlight.delete(key); }
  }
  private async materialize(root: Root): Promise<HostedPublication> {
    try {
      const wire = root.wire;
      if (wire.schemaVersion === 'primusscope-publication-v1') {
        const value = wire.compression === 'gzip-base64'
          ? JSON.parse(gunzipSync(Buffer.from(z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).parse(wire.publication), 'base64'),
            { maxOutputLength: MAX_BLOB_PUBLICATION_BYTES }).toString('utf8'))
          : wire.compression === 'compact-events-v1' ? expandPublication(wire.publication) : wire.publication;
        return validatePublication(value, MAX_BLOB_PUBLICATION_BYTES);
      }
      const parts: Record<PartitionKind, PartitionData[]> = { finance: [], network: [], strategyFlows: [] };
      const jobs = (['finance', 'network', 'strategyFlows'] as const).flatMap(kind => wire.partitions[kind].map((ref, index) => ({ kind, ref, index })));
      for (let offset = 0; offset < jobs.length; offset += 4) {
        const results = await Promise.allSettled(jobs.slice(offset, offset + 4).map(async job => {
          parts[job.kind][job.index] = await this.archive(job.kind, job.ref);
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      return restorePartitionedPublication(wire.publication, wire.partitions, parts);
    } catch { throw new StorageError('SOURCE_UNAVAILABLE'); }
  }
  private async writeRoot(wire: Wire, options: { ifMatch?: string; allowOverwrite?: boolean }, expiresAt?: number) {
    const raw = Buffer.from(JSON.stringify(wire));
    if (raw.byteLength > (wire.schemaVersion === 'primusscope-publication-v2' ? MAX_MANIFEST_BYTES : MAX_ENVELOPE_BYTES)) throw new StorageError('CAPACITY_EXCEEDED');
    const body = gzipSync(raw);
    if (body.byteLength > MAX_ENVELOPE_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
    // Uploads and compression may have outlived the original lease.
    if (expiresAt !== undefined && this.now() >= expiresAt) throw new StorageError('PUBLICATION_CONFLICT');
    try {
      const result = await this.client.put(BLOB_PATH, body, { access: 'private', token: this.token,
        ...options, ...(options.ifMatch ? { allowOverwrite: true } : {}) });
      if (!result.etag) throw new StorageError('DATABASE_UNAVAILABLE');
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(isPreconditionFailure(error) ? 'PUBLICATION_CONFLICT' : 'DATABASE_UNAVAILABLE');
    }
  }
  private async publicationWire(revision: string, publication: HostedPublication, root?: Root): Promise<Wire> {
    if (!this.partitionedWrites && root?.wire.schemaVersion !== 'primusscope-publication-v2') return legacyWire(revision, publication, null);
    const plan = planPartitionedPublication(publication);
    const existing = root?.wire.schemaVersion === 'primusscope-publication-v2'
      ? new Set(Object.entries(root.wire.partitions).flatMap(([kind, refs]) => refs.map(ref => kind + ':' + ref.sha256))) : new Set<string>();
    for (let offset = 0; offset < plan.uploads.length; offset += 4) {
      const results = await Promise.allSettled(plan.uploads.slice(offset, offset + 4).map(async upload => {
        if (existing.has(upload.kind + ':' + upload.ref.sha256)) { await this.archive(upload.kind, upload.ref); return; }
        try {
          const result = await this.client.put(archivePath(upload.kind, upload.ref), upload.body, { access: 'private', token: this.token, allowOverwrite: false });
          if (!result.etag) throw new Error();
          const data = decodePartition(upload.kind, upload.ref, upload.body);
          cachePut(this.cacheNamespace + upload.kind + ':' + upload.ref.sha256 + ':' + upload.ref.rawBytes, data, upload.ref.rawBytes);
        } catch {
          // Interrupted jobs may have staged this hash. Reconcile at origin;
          // never overwrite an immutable archive or trust an arbitrary collision.
          try { await this.archive(upload.kind, upload.ref, true); }
          catch { throw new StorageError('DATABASE_UNAVAILABLE'); }
        }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    return { schemaVersion: 'primusscope-publication-v2', revision, publication: plan.tail,
      compression: 'partitioned-events-v1', partitions: PartitionReferencesSchema.parse(plan.references), lease: null };
  }
  async read(): Promise<State | null> {
    if (!this.readOnly && this.ownedLease && this.ownedLease.expiresAt > this.now() && this.ownedState) return structuredClone(this.ownedState);
    const root = await this.root(); return root ? { revision: root.wire.revision, publication: await this.materialize(root) } : null;
  }
  async revision() { return (await this.root())?.wire.revision ?? null; }
  async initialize(input: HostedPublication): Promise<boolean> {
    this.writable(); const publication = validatePublication(input, this.publicationMaxBytes);
    const existing = await this.root();
    if (existing) {
      if ((await this.materialize(existing)).snapshot.snapshotId !== publication.snapshot.snapshotId) throw new StorageError('SEED_MISMATCH');
      return false;
    }
    try { await this.writeRoot(await this.publicationWire('0', publication), { allowOverwrite: false }); return true; }
    catch (error) {
      const current = await this.root(); if (!current) throw error;
      if ((await this.materialize(current)).snapshot.snapshotId !== publication.snapshot.snapshotId) throw new StorageError('SEED_MISMATCH');
      return false;
    }
  }
  async acquireLease(owner: string, seconds = 600): Promise<string | null> {
    this.writable();
    if (!OWNER.test(owner) || !Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new StorageError('INVALID_LEASE');
    const root = await this.root(); if (!root) throw new StorageError('NOT_INITIALIZED');
    if (!Number.isSafeInteger(this.now())) throw new StorageError('INVALID_TIME');
    if (root.wire.lease && root.wire.lease.expiresAt > this.now()) { this.ownedLease = null; this.ownedState = null; return null; }
    const publication = await this.materialize(root), now = this.now();
    if (!Number.isSafeInteger(now)) throw new StorageError('INVALID_TIME');
    const lease: Lease = { token: randomUUID(), owner, expiresAt: now + seconds * 1000 };
    try { await this.writeRoot({ ...root.wire, lease }, { ifMatch: root.etag }, lease.expiresAt); }
    catch (error) { if (error instanceof StorageError && error.code === 'PUBLICATION_CONFLICT') return null; throw error; }
    this.ownedLease = lease; this.ownedState = { revision: root.wire.revision, publication }; return lease.token;
  }
  async renewLease(token: string, seconds = 600): Promise<void> {
    this.writable();
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new StorageError('INVALID_LEASE');
    const now = this.now(); if (!Number.isSafeInteger(now)) throw new StorageError('INVALID_TIME');
    if (!this.ownedLease || this.ownedLease.token !== token || this.ownedLease.expiresAt <= now + 30_000) throw new StorageError('LEASE_LOST');
  }
  async publish(token: string, expectedRevision: string, input: HostedPublication): Promise<string> {
    this.writable(); const publication = validatePublication(input, this.publicationMaxBytes);
    if (!REVISION.test(expectedRevision)) throw new StorageError('INVALID_REVISION');
    const root = await this.root(), now = this.now();
    if (!root || !Number.isSafeInteger(now) || root.wire.revision !== expectedRevision || !root.wire.lease
      || root.wire.lease.token !== token || root.wire.lease.expiresAt <= now) throw new StorageError('PUBLICATION_CONFLICT');
    const next = String(BigInt(root.wire.revision) + 1n); if (!REVISION.test(next)) throw new StorageError('CAPACITY_EXCEEDED');
    const wire = await this.publicationWire(next, publication, root);
    await this.writeRoot(wire, { ifMatch: root.etag }, root.wire.lease.expiresAt);
    this.ownedLease = null; this.ownedState = null; return next;
  }
  async releaseLease(token: string): Promise<void> {
    this.writable(); if (!this.ownedLease) return;
    const root = await this.root();
    if (!root || root.wire.lease?.token !== token) { if (this.ownedLease?.token === token) { this.ownedLease = null; this.ownedState = null; } return; }
    try { await this.writeRoot({ ...root.wire, lease: null }, { ifMatch: root.etag }); }
    catch (error) { if (!(error instanceof StorageError) || error.code !== 'PUBLICATION_CONFLICT') throw error; }
    if (this.ownedLease?.token === token) { this.ownedLease = null; this.ownedState = null; }
  }
}
