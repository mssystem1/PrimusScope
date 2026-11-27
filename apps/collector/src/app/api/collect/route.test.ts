import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectHosted: vi.fn(),
  FetchRpc: vi.fn(),
  neonClient: vi.fn(),
  PostgresPublicationStore: vi.fn(),
  BlobPublicationStore:vi.fn(),
  recordCollectorFailure:vi.fn(),
  verifyRecoveryToken:vi.fn(),
}));
vi.mock('@primusscope/worker/hosted', () => ({ collectHosted: mocks.collectHosted }));
vi.mock('@primusscope/worker/fetch-rpc', () => ({ FetchRpc: mocks.FetchRpc }));
vi.mock('@primusscope/storage/postgres', () => ({
  neonClient: mocks.neonClient,
  PostgresPublicationStore: mocks.PostgresPublicationStore,
}));
vi.mock('@primusscope/storage/blob',()=>({BlobPublicationStore:mocks.BlobPublicationStore}));
vi.mock('@primusscope/storage/collector-status',()=>({recordCollectorFailure:mocks.recordCollectorFailure}));
vi.mock('../../../recovery-auth',()=>({verifyRecoveryToken:mocks.verifyRecoveryToken}));
vi.mock('@primusscope/storage', () => ({ StorageError: class StorageError extends Error { constructor(readonly code='STORAGE_FAILED'){super(code);} } }));

import { GET } from './route';
import {SDKDiagnosticsStore} from '@primusscope/storage/diagnostics';
import {StorageError} from '@primusscope/storage';

const oldSecret = process.env.CRON_SECRET;
const oldDatabase = process.env.WORKER_DATABASE_URL;
const oldStrategyFlag = process.env.PRIMUSSCOPE_STRATEGY_ENABLED;
const oldStoreFlag=process.env.PRIMUSSCOPE_PUBLICATION_STORE;
const secret = 's'.repeat(48);
function request(url = 'https://collector.example/api/collect', authorization = `Bearer ${secret}`) {
  return new Request(url, { headers: { authorization } });
}

beforeEach(() => {
  process.env.CRON_SECRET = secret;
  process.env.WORKER_DATABASE_URL = 'postgres://test.invalid/db';
  vi.clearAllMocks();
  mocks.verifyRecoveryToken.mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  if (oldDatabase === undefined) delete process.env.WORKER_DATABASE_URL; else process.env.WORKER_DATABASE_URL = oldDatabase;
  if (oldStrategyFlag === undefined) delete process.env.PRIMUSSCOPE_STRATEGY_ENABLED; else process.env.PRIMUSSCOPE_STRATEGY_ENABLED = oldStrategyFlag;
  if(oldStoreFlag===undefined)delete process.env.PRIMUSSCOPE_PUBLICATION_STORE;else process.env.PRIMUSSCOPE_PUBLICATION_STORE=oldStoreFlag;
});

describe('scheduled collection route', () => {
  it('allows a verified recovery identity without an additional stored secret and ignores a spoofed run header',async()=>{
    delete process.env.CRON_SECRET;
    const run='https://github.com/mssystem1/PrimusScope/actions/runs/12345';
    mocks.verifyRecoveryToken.mockResolvedValueOnce({runUrl:run});mocks.collectHosted.mockResolvedValueOnce({outcome:'completed'});
    vi.spyOn(SDKDiagnosticsStore.prototype,'prune').mockResolvedValue();
    const response=await GET(new Request('https://collector.example/api/collect',{headers:{authorization:'Bearer short-lived-identity','X-PrimusScope-Recovery-Run':'https://github.com/mssystem1/PrimusScope/actions/runs/999'}}));
    expect(response.status).toBe(200);expect(mocks.collectHosted.mock.calls[0][0].collector.runUrl).toBe(run);
  });
  it('records only a validated repository recovery URL with an authenticated run',async()=>{
    mocks.collectHosted.mockResolvedValue({outcome:'completed'});
    vi.spyOn(SDKDiagnosticsStore.prototype,'prune').mockResolvedValue();
    const run='https://github.com/mssystem1/PrimusScope/actions/runs/12345';
    await GET(new Request('https://collector.example/api/collect',{headers:{authorization:`Bearer ${secret}`,'X-PrimusScope-Recovery-Run':run}}));
    expect(mocks.collectHosted.mock.calls[0][0].collector.runUrl).toBe(run);
    await GET(new Request('https://collector.example/api/collect',{headers:{authorization:`Bearer ${secret}`,'X-PrimusScope-Recovery-Run':'https://private.invalid/?token=secret'}}));
    expect(mocks.collectHosted.mock.calls[1][0].collector.runUrl).toBeNull();
  });
  it('never falls back to Neon writes if Blob mode is missing while history-only is enabled',async()=>{
    vi.stubEnv('PRIMUSSCOPE_NEON_HISTORY_ONLY','1');
    const response=await GET(request());
    expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'HISTORY_READ_ONLY'});
    expect(mocks.neonClient).not.toHaveBeenCalled();expect(mocks.collectHosted).not.toHaveBeenCalled();
  });
  it('uses Blob for new publications and performs no Neon writes or retention mutations',async()=>{
    process.env.PRIMUSSCOPE_PUBLICATION_STORE='blob';delete process.env.WORKER_DATABASE_URL;
    const store={revision:vi.fn().mockResolvedValue('1'),read:vi.fn()};mocks.BlobPublicationStore.mockImplementation(function(){return store;});mocks.collectHosted.mockResolvedValueOnce({outcome:'completed'});const prune=vi.spyOn(SDKDiagnosticsStore.prototype,'prune');
    const response=await GET(request());expect(response.status).toBe(200);expect(response.headers.get('x-primusscope-diagnostics-retention')).toBe('history_read_only');expect(mocks.collectHosted.mock.calls[0][0]).toMatchObject({store,commitOnce:true,limits:{maxBlocks:40000,chunkSize:5000},collector:{provider:'vercel_cron',intervalMinutes:60}});expect(mocks.neonClient).not.toHaveBeenCalled();expect(prune).not.toHaveBeenCalled();
    mocks.collectHosted.mock.calls[0][0].rpcFor("network");expect(mocks.FetchRpc.mock.calls[0][1]).toMatchObject({maxRequests:2000,minIntervalMs:125});
    expect(mocks.BlobPublicationStore).toHaveBeenCalledWith({token:process.env.BLOB_READ_WRITE_TOKEN,partitionedWrites:true});
    expect(store.revision).toHaveBeenCalledOnce();expect(store.read).not.toHaveBeenCalled();
  });
  it('records a sanitized global Blob publication failure best-effort',async()=>{
    process.env.PRIMUSSCOPE_PUBLICATION_STORE='blob';delete process.env.WORKER_DATABASE_URL;
    const store={revision:vi.fn().mockResolvedValue('2')};mocks.BlobPublicationStore.mockImplementation(function(){return store;});
    mocks.collectHosted.mockRejectedValueOnce(new StorageError('CAPACITY_EXCEEDED'));
    const response=await GET(request());expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'CAPACITY_EXCEEDED'});
    expect(mocks.recordCollectorFailure).toHaveBeenCalledWith('CAPACITY_EXCEEDED',{token:process.env.BLOB_READ_WRITE_TOKEN});
    expect(mocks.neonClient).not.toHaveBeenCalled();
  });
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
