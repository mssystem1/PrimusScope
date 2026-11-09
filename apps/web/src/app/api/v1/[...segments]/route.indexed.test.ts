import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteStore } from '@primusscope/storage';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../../../../../../../data/observations/current.json';
import { GET } from './route';

const seed = ObservationSetSchema.parse(recorded);
const stores: SQLiteStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function get(path: string) {
  return GET(new NextRequest('https://example.test/api/v1/' + path), {
    params: Promise.resolve({ segments: path.split('/') }),
  });
}
function indexedDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'primusscope-api-indexed-')); directories.push(directory);
  const path = join(directory, 'private-store.sqlite');
  const store = new SQLiteStore(path, { clock: () => new Date('2026-11-09T09:00:00Z') }); stores.push(store);
  store.initialize(seed, { finance: '0x' + '11'.repeat(32), network: '0x' + '22'.repeat(32) });
  vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'indexed'); vi.stubEnv('PRIMUSSCOPE_DB_PATH', path); vi.stubEnv('VERCEL', '');
  return store;
}

describe('indexed-mode HTTP publication boundary', () => {
  it('serves indexed metadata consistently across JSON, CSV and headers', async () => {
    indexedDatabase();
    const overview = await get('overview');
    expect(overview.status).toBe(200);
    expect(overview.headers.get('X-PrimusScope-Data-Mode')).toBe('indexed-observations');
    expect(await overview.json()).toMatchObject({ mode: 'indexed_observations', snapshotId: seed.snapshotId,
      indexerStatus: { publication: 'available', continuousWorker: false } });
    const csv = await get('exports/metrics.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('X-PrimusScope-Data-Mode')).toBe('indexed-observations');
    expect(await csv.text()).toContain('indexed_observations');
  });

  it('returns status during quarantine while data and health fail with safe 503s', async () => {
    const store = indexedDatabase(); const lease = store.acquireLease('finance', 'private-worker-owner')!;
    store.quarantine('finance', lease.token, 'REORG_DETECTED'); store.releaseLease(lease.token);
    const status = await get('status/indexer');
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toMatchObject({ mode: 'indexed_observations', publication: 'quarantined' });
    expect(statusText).not.toContain('private-worker-owner');
    expect(statusText).not.toContain('private-store');
    for (const path of ['overview', 'health', 'finance/vaults', 'exports/metrics.csv']) {
      const response = await get(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'PUBLICATION_QUARANTINED', retryable: true });
    }
  });

  it('rejects unavailable storage and unsafe deployment configuration without fallback or detail echo', async () => {
    vi.stubEnv('PRIMUSSCOPE_DATA_MODE', 'indexed'); vi.stubEnv('PRIMUSSCOPE_DB_PATH', '/private-missing/database.sqlite');
    vi.stubEnv('VERCEL', '');
    const missing = await get('overview'); expect(missing.status).toBe(503);
    const missingText = await missing.text(); expect(missingText).not.toContain('private-missing');
    expect(JSON.parse(missingText)).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    vi.stubEnv('VERCEL', '1');
    const deployed = await get('status/indexer'); expect(deployed.status).toBe(503);
    expect(await deployed.json()).toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });
});
