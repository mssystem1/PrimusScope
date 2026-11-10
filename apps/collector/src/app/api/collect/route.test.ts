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
import {SDKDiagnosticsStore} from '@primusscope/storage/diagnostics';

const oldSecret = process.env.CRON_SECRET;
const oldDatabase = process.env.WORKER_DATABASE_URL;
const oldStrategyFlag = process.env.PRIMUSSCOPE_STRATEGY_ENABLED;
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
  vi.restoreAllMocks();
  if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  if (oldDatabase === undefined) delete process.env.WORKER_DATABASE_URL; else process.env.WORKER_DATABASE_URL = oldDatabase;
  if (oldStrategyFlag === undefined) delete process.env.PRIMUSSCOPE_STRATEGY_ENABLED; else process.env.PRIMUSSCOPE_STRATEGY_ENABLED = oldStrategyFlag;
});

describe('scheduled collection route', () => {
  it('prunes expired diagnostic metadata after completed collection and reports the retention outcome',async()=>{
    mocks.collectHosted.mockResolvedValueOnce({outcome:'completed'});
    const prune=vi.spyOn(SDKDiagnosticsStore.prototype,'prune').mockResolvedValueOnce();
    const response=await GET(request());expect(response.status).toBe(200);expect(prune).toHaveBeenCalledOnce();expect(response.headers.get('x-primusscope-diagnostics-retention')).toBe('pruned');
  });
  it('keeps completed chain work when independent diagnostic retention is unavailable',async()=>{
    mocks.collectHosted.mockResolvedValueOnce({outcome:'completed'});
    vi.spyOn(SDKDiagnosticsStore.prototype,'prune').mockRejectedValueOnce(new Error('PRIVATE_DATABASE_DETAIL'));
    const response=await GET(request());expect(response.status).toBe(200);expect(response.headers.get('x-primusscope-diagnostics-retention')).toBe('unavailable');expect(await response.text()).not.toContain('PRIVATE_DATABASE_DETAIL');
  });
  it('reserves time for strategy and Network collection within the shared invocation budget', async () => {
    process.env.PRIMUSSCOPE_STRATEGY_ENABLED = '1';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mocks.collectHosted.mockImplementationOnce(async options => {
      expect(options.collectStrategy).toEqual(expect.any(Function));
      options.rpcFor('finance');
      clock.mockReturnValue(1_215_000);
      options.rpcFor('network');
      return { outcome: 'completed' };
    });
    expect((await GET(request())).status).toBe(200);
    expect(mocks.FetchRpc.mock.calls[0][1].maxSeconds).toBe(110);
    expect(mocks.FetchRpc.mock.calls[1][1].maxSeconds).toBe(25);
  });
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
