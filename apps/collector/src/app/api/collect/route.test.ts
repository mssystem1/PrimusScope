import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectHosted: vi.fn(),
  FetchRpc: vi.fn(),
  neonClient: vi.fn(),
  PostgresPublicationStore: vi.fn(),
}));
vi.mock('@primusscope/worker/hosted', () => ({ collectHosted: mocks.collectHosted }));
vi.mock('@primusscope/worker/fetch-rpc', () => ({ FetchRpc: mocks.FetchRpc }));
vi.mock('@primusscope/storage/postgres', () => ({
  neonClient: mocks.neonClient,
  PostgresPublicationStore: mocks.PostgresPublicationStore,
}));
vi.mock('@primusscope/storage', () => ({ StorageError: class StorageError extends Error { code = 'STORAGE_FAILED'; } }));

import { GET } from './route';

const oldSecret = process.env.CRON_SECRET;
const oldDatabase = process.env.WORKER_DATABASE_URL;
const secret = 's'.repeat(48);
function request(url = 'https://collector.example/api/collect', authorization = `Bearer ${secret}`) {
  return new Request(url, { headers: { authorization } });
}

beforeEach(() => {
  process.env.CRON_SECRET = secret;
  process.env.WORKER_DATABASE_URL = 'postgres://test.invalid/db';
  vi.clearAllMocks();
});
afterEach(() => {
  if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  if (oldDatabase === undefined) delete process.env.WORKER_DATABASE_URL; else process.env.WORKER_DATABASE_URL = oldDatabase;
});

describe('scheduled collection route', () => {
  it('rejects unauthorized requests before database setup or collection RPC work', async () => {
    const response = await GET(request('https://collector.example/api/collect', 'Bearer wrong'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.neonClient).not.toHaveBeenCalled();
    expect(mocks.PostgresPublicationStore).not.toHaveBeenCalled();
    expect(mocks.collectHosted).not.toHaveBeenCalled();
    expect(mocks.FetchRpc).not.toHaveBeenCalled();
  });

  it('rejects query parameters before touching the database', async () => {
    const response = await GET(request('https://collector.example/api/collect?secret=private'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' });
    expect(mocks.neonClient).not.toHaveBeenCalled();
    expect(mocks.collectHosted).not.toHaveBeenCalled();
  });

  it('reports missing database configuration after authorization', async () => {
    delete process.env.WORKER_DATABASE_URL;
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'DATABASE_NOT_CONFIGURED' });
    expect(mocks.neonClient).not.toHaveBeenCalled();
    expect(mocks.collectHosted).not.toHaveBeenCalled();
  });
});
