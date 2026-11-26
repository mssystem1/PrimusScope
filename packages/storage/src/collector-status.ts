import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { z } from 'zod';

const PATH = 'primusscope/private-collector-status/v1/latest-failure.json';
const MAX_BYTES = 1024;
const codes = ['CAPACITY_EXCEEDED', 'DATABASE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'PUBLICATION_CONFLICT',
  'LEASE_BUSY', 'LEASE_LOST', 'NOT_INITIALIZED', 'INVALID_PUBLICATION', 'COLLECTION_FAILED'] as const;
export const CollectorFailureSchema = z.object({
  version: z.literal(1), failedAt: z.iso.datetime(), code: z.enum(codes),
}).strict();
export type CollectorFailure = z.infer<typeof CollectorFailureSchema>;

export interface CollectorStatusTransport {
  read(): Promise<{ etag: string; bytes: Uint8Array } | null>;
  write(bytes: Uint8Array, etag?: string): Promise<void>;
}

function sdkTransport(token?: string): CollectorStatusTransport {
  return {
    async read() {
      const result = await get(PATH, { access: 'private', useCache: false, token, headers: { 'Accept-Encoding': 'identity' },
        abortSignal: AbortSignal.timeout(1000) });
      if (!result) return null;
      if (result.statusCode !== 200 || !result.stream || result.blob.etag.startsWith('W/')) throw new Error('STATUS_UNAVAILABLE');
      const reader = result.stream.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error('STATUS_UNAVAILABLE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return { etag: result.blob.etag, bytes: Buffer.concat(chunks) };
    },
    async write(bytes, etag) {
      await put(PATH, Buffer.from(bytes), { access: 'private', token, addRandomSuffix: false,
        contentType: 'application/json', cacheControlMaxAge: 60, ttlDays: 30,
        allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {}),
        abortSignal: AbortSignal.timeout(1000) });
    },
  };
}

function decode(bytes: Uint8Array): CollectorFailure {
  if (bytes.byteLength > MAX_BYTES) throw new Error('STATUS_UNAVAILABLE');
  const parsed = CollectorFailureSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!parsed.success) throw new Error('STATUS_UNAVAILABLE');
  return parsed.data;
}

/** Best-effort sidecar; deliberately separate from the observation publication. */
export async function recordCollectorFailure(code: string, options: {
  token?: string; transport?: CollectorStatusTransport; now?: () => number;
} = {}): Promise<void> {
  const safeCode = codes.includes(code as typeof codes[number]) ? code as typeof codes[number] : 'COLLECTION_FAILED';
  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(now)) return;
  const failure: CollectorFailure = { version: 1, failedAt: new Date(now).toISOString(), code: safeCode };
  const transport = options.transport ?? sdkTransport(options.token);
  const bytes = new TextEncoder().encode(JSON.stringify(failure));
  const deadline=Date.now()+2200;
  for (let attempt = 0; attempt < 3 && Date.now()<deadline; attempt++) {
    try {
      const current = await transport.read();
      if (current) {
        try { if (decode(current.bytes).failedAt >= failure.failedAt) return; }
        catch { /* Replace a corrupt sidecar using its ETag; never block collection on it. */ }
      }
      await transport.write(bytes, current?.etag);
      return;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError || (error as { name?: unknown })?.name === 'BlobPreconditionFailedError') continue;
      throw error;
    }
  }
  throw new Error('STATUS_CONFLICT');
}

/** Read-side callers must treat errors as missing status and keep the publication available. */
export async function readCollectorFailure(options: {
  token?: string; transport?: CollectorStatusTransport;
} = {}): Promise<CollectorFailure | null> {
  const raw = await (options.transport ?? sdkTransport(options.token)).read();
  return raw ? decode(raw.bytes) : null;
}
