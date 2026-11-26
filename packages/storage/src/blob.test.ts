import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteStore } from './index';
import { BlobPublicationStore, MAX_ENVELOPE_BYTES, type BlobCASClient } from './blob';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../../../data/observations/current.json';
import { MAX_BLOB_PUBLICATION_BYTES, MAX_PUBLICATION_BYTES, validatePublication } from './publication';
import { collectHosted } from '../../../apps/worker/src/hosted';
import type { RunReport } from '../../../apps/worker/src/indexer';
import { gzipSync, gunzipSync } from 'node:zlib';
import { compactPublication, expandPublication } from './compact-publication';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function publication() {
  const path = mkdtempSync(join(tmpdir(), 'primusscope-blob-test-')); temporary.push(path);
  const local = new SQLiteStore(join(path, 'local.sqlite'));
  local.initialize(ObservationSetSchema.parse(recorded), { finance: '0x' + '11'.repeat(32), network: '0x' + '22'.repeat(32) });
  const result = local.exportPublication(); local.close(); return result;
}

class PreconditionFailed extends Error {
  constructor() { super('Precondition failed'); this.name = 'BlobPreconditionFailedError'; }
}

class FakeCAS implements BlobCASClient {
  private bytes: Uint8Array | null = null;
  private etag = '0';
  writes = 0;
  reads: boolean[] = [];
  failNextWrite: Error | null = null;
  beforeWrite: (() => void) | null = null;

  async get(_pathname: string, options: { access: 'private'; useCache: boolean }) {
    this.reads.push(options.useCache);
    if (!this.bytes) return null;
    const snapshot = this.bytes.slice();
    return { etag: this.etag, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(snapshot); controller.close(); } }) };
  }

  async put(_pathname: string, body: Uint8Array, options: { access: 'private'; allowOverwrite?: boolean; ifMatch?: string }) {
    await Promise.resolve();
    this.beforeWrite?.(); this.beforeWrite = null;
    if (this.failNextWrite) { const error = this.failNextWrite; this.failNextWrite = null; throw error; }
    if (options.ifMatch !== undefined && options.ifMatch !== this.etag) throw new PreconditionFailed();
    if(options.ifMatch!==undefined&&options.allowOverwrite!==true)throw new Error('Conditional replacement requires overwrite permission.');
    if (options.ifMatch === undefined && this.bytes && options.allowOverwrite !== true) throw new PreconditionFailed();
    this.bytes = body.slice(); this.etag = String(Number(this.etag) + 1); this.writes++;
    return { etag: this.etag };
  }

  raw(): Uint8Array | null { return this.bytes?.slice() ?? null; }
  corrupt(text: string): void { this.bytes = new TextEncoder().encode(text); this.etag = String(Number(this.etag) + 1); }
  replaceRaw(bytes: Uint8Array): void { this.bytes = bytes.slice(); this.etag = String(Number(this.etag) + 1); }
}

function store(transport: FakeCAS, options: { readOnly?: boolean; useCache?: boolean; clock?: () => number } = {}) {
  return new BlobPublicationStore({ transport, ...options });
}

describe('Blob durable publication protocol', () => {
  it('reads legacy envelopes and rewrites the same history as compact binary gzip', async () => {
    const transport = new FakeCAS(), seed = publication(), client = store(transport);
    const legacy = { schemaVersion: 'primusscope-publication-v1', revision: '119', lease: null,
      compression: 'gzip-base64', publication: gzipSync(Buffer.from(JSON.stringify(seed))).toString('base64') };
    transport.corrupt(JSON.stringify(legacy));
    expect((await client.read())?.publication).toEqual(seed);
    const token = (await client.acquireLease('compact-upgrade'))!;
    expect(Array.from(transport.raw()!.subarray(0, 2))).toEqual([0x1f, 0x8b]);
    expect(await client.publish(token, '119', seed)).toBe('120');
    const after = await store(transport, { readOnly: true }).read();
    expect(after?.publication).toEqual(seed);
    const wire = JSON.parse(gunzipSync(transport.raw()!).toString());
    expect(wire.compression).toBe('compact-events-v1');
    expect(wire.publication.snapshot.network.events[0]).toBeInstanceOf(Array);
    expect(wire.publication.snapshot.network.events).toHaveLength(seed.snapshot.network.events.length);
  });

  it('preserves noncanonical IDs and address casing exactly and rejects malformed compact rows', () => {
    const seed = publication(), first = seed.snapshot.network.events[0]!;
    first.contractAddress = first.contractAddress.toUpperCase().replace('0X', '0x');
    first.id = [8453, first.contractAddress, first.transactionHash, first.logIndex].join(':');
    seed.snapshot.network.events[1]!.id = 'retained:seed:custom-id';
    expect(validatePublication(expandPublication(compactPublication(seed)), MAX_BLOB_PUBLICATION_BYTES)).toEqual(seed);
    const bad = compactPublication(seed); bad.snapshot.network.events[0]![3] = 'invalid-hash';
    expect(() => expandPublication(bad)).toThrow();
  });

  it('restores, collects and rereads a Blob publication above the legacy Neon budget without truncating history', async () => {
    const seed = publication(), source = seed.snapshot.network.events[0]!;
    seed.snapshot.network.events = Array.from({ length: 22_000 }, (_, index) => ({
      ...source, id: `capacity:${index}:` + 'x'.repeat(450),
      transactionHash: '0x' + index.toString(16).padStart(64, '0'), logIndex: String(index),
    }));
    expect(Buffer.byteLength(JSON.stringify(seed))).toBeGreaterThan(MAX_PUBLICATION_BYTES);
    expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThan(MAX_BLOB_PUBLICATION_BYTES);
    expect(() => validatePublication(seed)).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }));
    const transport = new FakeCAS(), client = store(transport);
    await client.initialize(seed);
    expect((await store(transport, { readOnly: true }).read())?.publication.snapshot.network.events).toHaveLength(22_000);
    const result = await collectHosted({ store: client, commitOnce: true,
      collector: { mode: 'scheduled', provider: 'vercel_cron', intervalMinutes: 60, runUrl: null },
      rpcFor: () => ({ requestsMade: 0, async call() { throw new Error('Unexpected RPC'); } }),
      runDomain: async (_local, _rpc, domain) => ({ domain, outcome: 'idle' } as RunReport),
    });
    expect(result).toMatchObject({ outcome: 'completed', revision: '1' });
    const after = await store(transport, { readOnly: true }).read();
    expect(after?.publication.snapshot.network.events).toEqual(seed.snapshot.network.events);
    expect(after?.publication.checkpoints).toEqual(seed.checkpoints);
    expect(() => validatePublication(after?.publication)).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }));
  }, 30_000);

  it('initializes once, resolves a concurrent initializer, and rejects a different seed', async () => {
    const transport = new FakeCAS(), first = store(transport), second = store(transport), seed = publication();
    const results = await Promise.all([first.initialize(seed), second.initialize(seed)]);
    expect(results.sort()).toEqual([false, true]);
    const other = structuredClone(seed); other.snapshot.snapshotId = 'a'.repeat(64);
    await expect(first.initialize(other)).rejects.toMatchObject({ code: 'SEED_MISMATCH' });
    expect((await first.read())?.publication.snapshot.snapshotId).toBe(seed.snapshot.snapshotId);
  });

  it('grants a single lease and fences stale token, revision, expiry, and release', async () => {
    let now = 1_800_000_000_000;
    const transport = new FakeCAS(), seed = publication();
    const first = store(transport, { clock: () => now }), second = store(transport, { clock: () => now });
    await first.initialize(seed);
    const acquired = await Promise.all([first.acquireLease('worker-1'), second.acquireLease('worker-2')]);
    const token = acquired.find(Boolean)!;
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const owner = acquired[0] ? first : second;
    const stale = owner === first ? second : first;
    expect(await stale.acquireLease('busy')).toBeNull();
    now += 600_001;
    const successor = await stale.acquireLease('successor'); expect(successor).toBeTruthy();
    await owner.releaseLease(token);
    expect(await first.acquireLease('still-busy')).toBeNull();
    await expect(owner.publish(token, '0', seed)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    expect((await first.read())?.revision).toBe('0');
    await expect(stale.publish(successor!, '7', seed)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
  });

  it('publishes once per lease with two writes total and preserves last bytes on quota failure', async () => {
    const transport = new FakeCAS(), client = store(transport), seed = publication();
    await client.initialize(seed); const token = (await client.acquireLease('worker'))!;
    const beforePublish = transport.writes;
    const next = structuredClone(seed); next.collector.mode = 'manual';
    expect(await client.publish(token, '0', next)).toBe('1');
    expect(transport.writes - beforePublish).toBe(1);
    expect(transport.writes).toBe(3); // initialize + acquire + publish
    await expect(client.publish(token, '1', next)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });

    const token2 = (await client.acquireLease('worker-2'))!;
    const validBytes = transport.raw();
    transport.failNextWrite = new Error('quota rejected; secret URL must not escape');
    await expect(client.publish(token2, '1', next)).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(transport.raw()).toEqual(validBytes); // failed put did not replace the last valid envelope
    expect((await client.read())?.revision).toBe('1');
  });

  it('validates cached renewal without a write, expires leases, and applies configured read caching', async () => {
    let now = 1_800_000_000_000;
    const transport = new FakeCAS(), writer = store(transport, { clock: () => now });
    await writer.initialize(publication()); const token = (await writer.acquireLease('worker'))!;
    const writes = transport.writes;
    await writer.renewLease(token);
    expect(transport.writes).toBe(writes);
    now += 571_000;
    await expect(writer.renewLease(token)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const reader = store(transport, { readOnly: true, useCache: true, clock: () => now });
    expect(await reader.revision()).toBe('0');
    expect(transport.reads.at(-1)).toBe(true);
    await expect(reader.acquireLease('web')).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  it('rejects malformed and oversized private envelopes without exposing bytes or URLs', async () => {
    const transport = new FakeCAS(), client = store(transport);
    transport.corrupt('{"secret":"do-not-return"}');
    await expect(client.read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    transport.replaceRaw(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
    await expect(client.read()).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
  });
});
