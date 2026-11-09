import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SQLiteStore } from '@primusscope/storage';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../../../data/observations/current.json';
import { getServingState, getIndexerStatus } from './serving';

const mocks = vi.hoisted(() => ({ neonClient: vi.fn() }));
vi.mock('@primusscope/storage/postgres', async importOriginal => ({
  ...await importOriginal<typeof import('@primusscope/storage/postgres')>(), neonClient: mocks.neonClient,
}));
function seed() {
  const directory = mkdtempSync(join(tmpdir(), 'primusscope-hosted-reader-'));
  const local = new SQLiteStore(join(directory, 'seed.sqlite'));
  try {
    local.initialize(ObservationSetSchema.parse(recorded), { finance: '0x' + '11'.repeat(32), network: '0x' + '22'.repeat(32) });
    return local.exportPublication({ mode: 'scheduled', provider: 'vercel_cron', intervalMinutes: 15, runUrl: null });
  } finally { local.close(); rmSync(directory, { recursive: true, force: true }); }
}
beforeEach(() => { vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'hosted'); mocks.neonClient.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

it('requires only the reader credential and never falls back to the bundled snapshot or admin DSN', async () => {
  vi.stubEnv('WEB_DATABASE_URL', ''); vi.stubEnv('DATABASE_URL', 'private-admin-value');
  await expect(getServingState()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 503 });
  expect(mocks.neonClient).not.toHaveBeenCalled();
});
it('checks revisions on warm reads, isolates caller mutations, and refuses stale cache on database failure', async () => {
  vi.stubEnv('WEB_DATABASE_URL', 'test-reader-1');
  let publication = seed(), revision = '0', fullReads = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes(', state')) { fullReads++; return { rows: [{ revision, state: publication }] }; }
    return { rows: [{ revision }] };
  });
  mocks.neonClient.mockReturnValue({ query });
  const first = await getServingState(); first.snapshot.finance.events.pop();
  expect((await getServingState()).snapshot.finance.events).toHaveLength(9);
  expect(fullReads).toBe(1);
  publication = structuredClone(publication); publication.checkpoints[0]!.quarantined = true; revision = '1';
  expect((await getIndexerStatus()).publication).toBe('quarantined'); expect(fullReads).toBe(2);
  await expect(getServingState()).rejects.toMatchObject({ code: 'PUBLICATION_QUARANTINED' });
  query.mockRejectedValue(new Error('private-connection-string') as never);
  await expect(getServingState()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await expect(getServingState()).rejects.not.toThrow('private-connection-string');
});
it('projects safe operational status and rejects private fields in the stored payload', async () => {
  vi.stubEnv('WEB_DATABASE_URL', 'test-reader-2'); const publication = seed();
  publication.checkpoints[0]!.lastErrorCode = 'RPC_ARCHIVE_UNAVAILABLE';
  mocks.neonClient.mockReturnValue({ query: async () => ({ rows: [{ revision: '0', state: publication }] }) });
  const status = await getIndexerStatus();
  expect(status).toMatchObject({ storage: 'hosted_postgres', collectionMode: 'scheduled', intervalMinutes: 15 });
  expect(status.domains[0]!.lastErrorCode).toBe('RPC_ARCHIVE_UNAVAILABLE');
  expect(JSON.stringify(status)).not.toContain('blockHash');
  vi.stubEnv('WEB_DATABASE_URL', 'test-reader-3');
  Object.assign(publication, { privateKey: 'must-not-escape' });
  await expect(getServingState()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
