import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SQLiteStore } from './index';
import { PostgresPublicationStore, neonClient, type SqlClient } from './postgres';
import { validatePublication } from './publication';
import { configureRuntimeRoles } from './roles';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../../../data/observations/current.json';

const temporary: string[] = [];
const databases: PGlite[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function publication() {
  const path = mkdtempSync(join(tmpdir(), 'primusscope-portable-test-')); temporary.push(path);
  const local = new SQLiteStore(join(path, 'local.sqlite'));
  local.initialize(ObservationSetSchema.parse(recorded), { finance: '0x' + '11'.repeat(32), network: '0x' + '22'.repeat(32) });
  const result = local.exportPublication(); local.close(); return result;
}
async function fixture() {
  const db = new PGlite(); databases.push(db);
  const client: SqlClient = { async query(sql, values = []) {
    const result = await db.query<Record<string, unknown>>(sql, values); return { rows: result.rows };
  } };
  const store = new PostgresPublicationStore(client); await store.migrate();
  return { db, client, store };
}

describe('Postgres durable publication protocol', () => {
  it('enforces actual SQL role privileges for the public reader and collector', async () => {
    const { store, client, db } = await fixture(); await store.initialize(publication());
    await configureRuntimeRoles(client, 'a'.repeat(43), 'b'.repeat(43));
    await db.query('SET ROLE primusscope_web');
    expect((await store.read())?.revision).toBe('0');
    await expect(db.query('DELETE FROM primusscope.publication')).rejects.toThrow('permission denied');
    await expect(db.query('SELECT * FROM primusscope.collector_lease')).rejects.toThrow('permission denied');
    await db.query('RESET ROLE'); await db.query('SET ROLE primusscope_worker');
    const token = await store.acquireLease('worker'); expect(token).toBeTruthy();
    await store.releaseLease(token!); await db.query('RESET ROLE');
  });
  it('initializes once and refuses a different seed without overwriting data', async () => {
    const { store } = await fixture(); const seed = publication();
    expect(await store.read()).toBeNull(); expect(await store.initialize(seed)).toBe(true);
    expect(await store.initialize(seed)).toBe(false);
    const other = structuredClone(seed); other.snapshot.snapshotId = 'a'.repeat(64);
    await expect(store.initialize(other)).rejects.toMatchObject({ code: 'SEED_MISMATCH' });
    expect((await store.read())?.publication.snapshot.snapshotId).toBe(seed.snapshot.snapshotId);
  });
  it('fences expired writers, stale revisions and stale release tokens', async () => {
    const { store, db } = await fixture(); const seed = publication(); await store.initialize(seed);
    const first = (await store.acquireLease('first'))!; expect(await store.acquireLease('other')).toBeNull();
    await db.query("UPDATE primusscope.collector_lease SET expires_at=clock_timestamp()-interval '1 second'");
    const second = (await store.acquireLease('second'))!;
    await expect(store.publish(first, '0', seed)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    await store.releaseLease(first); expect(await store.acquireLease('third')).toBeNull();
    expect(await store.publish(second, '0', seed)).toBe('1');
    await expect(store.publish(second, '0', seed)).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' });
    expect((await store.read())?.revision).toBe('1');
  });
  it('rejects private/corrupt state before publication and keeps the last valid revision', async () => {
    const { store } = await fixture(); const seed = publication(); await store.initialize(seed);
    const token = (await store.acquireLease('test'))!;
    const privateState = structuredClone(seed) as unknown as Record<string, unknown>; privateState.privateKey = 'must-not-store';
    await expect(store.publish(token, '0', privateState as never)).rejects.toMatchObject({ code: 'INVALID_PUBLICATION' });
    expect((await store.read())?.revision).toBe('0');
    const invalid = structuredClone(seed); invalid.checkpoints[0]!.toBlock = 'invalid';
    expect(() => validatePublication(invalid)).toThrow();
  });
  it('keeps the current publication readable across a fresh store instance with write access disabled', async () => {
    const { store, client } = await fixture(); const seed = publication(); await store.initialize(seed);
    const readOnly = new PostgresPublicationStore(client, true);
    expect((await readOnly.read())?.publication).toEqual(seed);
    await expect(readOnly.acquireLease('web')).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(readOnly.migrate()).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
  it('restores source times, cooldowns and quarantine into a fresh private job database', () => {
    const seed = publication();
    const finance = seed.checkpoints.find(c => c.domain === 'finance')!;
    finance.lastOutcome = 'failed'; finance.lastErrorCode = 'RATE_LIMITED'; finance.lastAttemptAt = '2026-11-10T00:00:00.000Z';
    finance.nextRetryAt = '2026-11-10T00:02:00.000Z'; finance.retryAfterSeconds = 120; finance.quarantined = true;
    const path = mkdtempSync(join(tmpdir(), 'primusscope-restored-test-')); temporary.push(path);
    const local = new SQLiteStore(join(path, 'job.sqlite')); local.restorePublication(seed);
    expect(local.getStatus().publication).toBe('quarantined');
    expect(() => local.readSnapshot()).toThrow();
    expect(local.exportPublication()).toEqual(seed); local.close();
  });
  it('rejects missing or unregistered database hosts without echoing credentials', () => {
    expect(() => neonClient('postgres://secret:password@untrusted.example/db')).toThrow('indexed observation store');
  });
});
