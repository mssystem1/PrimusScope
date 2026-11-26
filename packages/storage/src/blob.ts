import { randomUUID } from 'node:crypto';
import{gzipSync,gunzipSync}from'node:zlib';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { z } from 'zod';
import { StorageError } from './errors';
import { MAX_BLOB_PUBLICATION_BYTES, validatePublication, type HostedPublication } from './publication';
import { compactPublication, expandPublication } from './compact-publication';

const BLOB_PATH = 'primusscope/current-v1.json';
export const MAX_ENVELOPE_BYTES = MAX_BLOB_PUBLICATION_BYTES + 4096;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
const LeaseSchema = z.object({
  token: z.string().uuid(), owner: z.string().regex(OWNER), expiresAt: z.number().int().positive(),
}).strict();
const EnvelopeSchema = z.object({
  schemaVersion: z.literal('primusscope-publication-v1'),
  revision: z.string().regex(REVISION),
  publication: z.unknown(),
  compression:z.enum(['gzip-base64', 'compact-events-v1']).optional(),
  lease: LeaseSchema.nullable(),
}).strict();

type Lease = z.infer<typeof LeaseSchema>;
type Envelope = { schemaVersion: 'primusscope-publication-v1'; revision: string; publication: HostedPublication; lease: Lease | null };
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
  /** Used only for read-only callers; writers always bypass the CDN cache. */
  useCache?: boolean;
  clock?: () => number;
  transport?: BlobCASClient;
}

const sdkTransport: BlobCASClient = {
  async get(pathname, options) {
    const result = await get(pathname, { access: options.access, useCache: options.useCache, token: options.token,headers:{'Accept-Encoding':'identity'} });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new StorageError('SOURCE_UNAVAILABLE');
    if(!options.useCache&&result.blob.etag.startsWith('W/')){await result.stream.cancel();throw new StorageError('SOURCE_UNAVAILABLE');}
    return { etag: result.blob.etag, stream: result.stream };
  },
  async put(pathname, body, options) {
    const result = await put(pathname, Buffer.from(body), { access: options.access, allowOverwrite: options.allowOverwrite, ifMatch: options.ifMatch, token: options.token,addRandomSuffix:false,cacheControlMaxAge:60,contentType:'application/octet-stream' });
    return { etag: result.etag };
  },
};

function isPreconditionFailure(error: unknown): boolean {
  if(error instanceof BlobPreconditionFailedError)return true;
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return candidate?.name === 'BlobPreconditionFailedError' || candidate?.code === 'precondition_failed';
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENVELOPE_BYTES) {
        await reader.cancel();
        throw new StorageError('CAPACITY_EXCEEDED');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function decodeEnvelope(bytes: Uint8Array, etag: string): { envelope: Envelope; etag: string } {
  let value: unknown;
  try {
    const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_ENVELOPE_BYTES }) : bytes;
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  }
  catch { throw new StorageError('SOURCE_UNAVAILABLE'); }
  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success || !etag) throw new StorageError('SOURCE_UNAVAILABLE');
  let publication: HostedPublication;
  try {
    const source=parsed.data.compression==='gzip-base64'?JSON.parse(gunzipSync(Buffer.from(z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).parse(parsed.data.publication),'base64'),{maxOutputLength:MAX_BLOB_PUBLICATION_BYTES}).toString('utf8'))
      :parsed.data.compression==='compact-events-v1'?expandPublication(parsed.data.publication):parsed.data.publication;
    publication = validatePublication(source, MAX_BLOB_PUBLICATION_BYTES);
  }
  catch { throw new StorageError('SOURCE_UNAVAILABLE'); }
  return { envelope: {schemaVersion:parsed.data.schemaVersion,revision:parsed.data.revision,lease:parsed.data.lease,publication}, etag };
}

/**
 * Durable publication state stored in one private Blob. All lease and publication
 * transitions use that object's ETag so lease fencing and revision changes share
 * one compare-and-swap boundary.
 */
export class BlobPublicationStore {
  readonly publicationMaxBytes = MAX_BLOB_PUBLICATION_BYTES;
  private readonly client: BlobCASClient;
  private readonly now: () => number;
  private readonly readOnly: boolean;
  private readonly readCache: boolean;
  private readonly token?: string;
  private ownedLease: Lease | null = null;
  private ownedState:{revision:string;publication:HostedPublication}|null=null;

  constructor(options: BlobPublicationStoreOptions = {}) {
    this.client = options.transport ?? sdkTransport;
    this.now = options.clock ?? Date.now;
    this.readOnly = options.readOnly ?? false;
    this.readCache = this.readOnly ? (options.useCache ?? true) : false;
    this.token = options.token;
  }

  private writable(): void { if (this.readOnly) throw new StorageError('READ_ONLY'); }

  private async current(): Promise<{ envelope: Envelope; etag: string } | null> {
    try {
      const blob = await this.client.get(BLOB_PATH, { access: 'private', useCache: this.readCache, token: this.token });
      if (!blob) return null;
      return decodeEnvelope(await readBytes(blob.stream), blob.etag);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('DATABASE_UNAVAILABLE');
    }
  }

  private async replace(envelope: Envelope, options: { ifMatch?: string; allowOverwrite?: boolean }): Promise<string> {
    const wire = { ...envelope, publication: compactPublication(envelope.publication), compression: 'compact-events-v1' };
    const raw = Buffer.from(JSON.stringify(wire));
    if (raw.byteLength > MAX_ENVELOPE_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
    const body = gzipSync(raw);
    if (body.byteLength > MAX_ENVELOPE_BYTES) throw new StorageError('CAPACITY_EXCEEDED');
    try {
      const result = await this.client.put(BLOB_PATH, body, {
        access: 'private', token: this.token, ...options,...options.ifMatch?{allowOverwrite:true}:{},
      });
      if (!result.etag) throw new StorageError('DATABASE_UNAVAILABLE');
      return result.etag;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (isPreconditionFailure(error)) throw new StorageError('PUBLICATION_CONFLICT');
      throw new StorageError('DATABASE_UNAVAILABLE');
    }
  }

  async read(): Promise<{ revision: string; publication: HostedPublication } | null> {
    if(!this.readOnly&&this.ownedLease&&this.ownedLease.expiresAt>this.now()&&this.ownedState)return structuredClone(this.ownedState);
    const current = await this.current();
    return current ? { revision: current.envelope.revision, publication: current.envelope.publication } : null;
  }

  async revision(): Promise<string | null> { return (await this.current())?.envelope.revision ?? null; }

  async initialize(input: HostedPublication): Promise<boolean> {
    this.writable();
    const publication = validatePublication(input, this.publicationMaxBytes);
    const initial: Envelope = { schemaVersion: 'primusscope-publication-v1', revision: '0', publication, lease: null };
    try {
      await this.replace(initial, { allowOverwrite: false });
      return true;
    } catch (error) {
      // The SDK documents no-overwrite creation but does not expose a dedicated
      // already-exists error. Re-read to resolve a concurrent initializer safely.
      const current = await this.current();
      if (current) {
        if (current.envelope.publication.snapshot.snapshotId !== publication.snapshot.snapshotId) {
          throw new StorageError('SEED_MISMATCH');
        }
        return false;
      }
      throw error;
    }
  }

  async acquireLease(owner: string, seconds = 600): Promise<string | null> {
    this.writable();
    if (!OWNER.test(owner) || !Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new StorageError('INVALID_LEASE');
    const current = await this.current();
    if (!current) throw new StorageError('NOT_INITIALIZED');
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new StorageError('INVALID_TIME');
    if (current.envelope.lease && current.envelope.lease.expiresAt > now) { this.ownedLease = null; return null; }
    const lease: Lease = { token: randomUUID(), owner, expiresAt: now + seconds * 1000 };
    try { await this.replace({ ...current.envelope, lease }, { ifMatch: current.etag }); }
    catch (error) {
      if (error instanceof StorageError && error.code === 'PUBLICATION_CONFLICT') return null;
      throw error;
    }
    this.ownedLease = lease;
    this.ownedState={revision:current.envelope.revision,publication:current.envelope.publication};
    return lease.token;
  }

  async renewLease(token: string, seconds = 600): Promise<void> {
    this.writable();
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new StorageError('INVALID_LEASE');
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new StorageError('INVALID_TIME');
    const cached = this.ownedLease;
    if (!cached || cached.token !== token || cached.expiresAt <= now + 30_000) throw new StorageError('LEASE_LOST');
    // The hosted collector commits once within a 300s job limit and uses a 600s
    // lease. Avoid an extra Blob write; this validates local lease freshness only.
  }

  async publish(token: string, expectedRevision: string, input: HostedPublication): Promise<string> {
    this.writable();
    const publication = validatePublication(input, this.publicationMaxBytes);
    if (!REVISION.test(expectedRevision)) throw new StorageError('INVALID_REVISION');
    const current = await this.current();
    const now = this.now();
    if (!current || !Number.isSafeInteger(now) || current.envelope.revision !== expectedRevision
      || !current.envelope.lease || current.envelope.lease.token !== token || current.envelope.lease.expiresAt <= now) {
      throw new StorageError('PUBLICATION_CONFLICT');
    }
    const nextRevision = String(BigInt(current.envelope.revision) + 1n);
    if (!REVISION.test(nextRevision)) throw new StorageError('CAPACITY_EXCEEDED');
    await this.replace({ ...current.envelope, revision: nextRevision, publication, lease: null }, { ifMatch: current.etag });
    this.ownedLease = null;
    this.ownedState=null;
    return nextRevision;
  }

  async releaseLease(token: string): Promise<void> {
    this.writable();
    if(!this.ownedLease)return;
    const current = await this.current();
    if (!current || current.envelope.lease?.token !== token) {
      if (this.ownedLease?.token === token) this.ownedLease = null;
      return;
    }
    try {
      await this.replace({ ...current.envelope, lease: null }, { ifMatch: current.etag });
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'PUBLICATION_CONFLICT') throw error;
      // The ETag changed. Releasing a stale lease must never erase its successor.
    }
    if (this.ownedLease?.token === token) this.ownedLease = null;
  }
}
