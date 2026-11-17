import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNeonHistoryState } from '@primusscope/data';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../../../../../../../../../data/observations/current.json';
import { GET } from './route';

vi.mock('@primusscope/data', async importOriginal => {
  const actual = await importOriginal<typeof import('@primusscope/data')>();
  return { ...actual, getNeonHistoryState: vi.fn() };
});

const snapshot = ObservationSetSchema.parse(recorded);
const historyRead = vi.mocked(getNeonHistoryState);

beforeEach(() => { historyRead.mockResolvedValue({ snapshot, mode: 'indexed_observations', indexerStatus: null }); });
afterEach(() => { historyRead.mockReset(); vi.unstubAllEnvs(); });

function get(path: string, query = '') {
  return GET(new NextRequest(`https://example.test/api/v1/history/neon/${path}${query}`), {
    params: Promise.resolve({ segments: path.split('/') }),
  });
}

describe('read-only historical Neon API', () => {
  it('serves overview and analytics with explicit historical source bounds', async () => {
    const overview = await get('overview');
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ historySource: 'neon', historyBounds: {
      finance: { chainId: 56, fromBlock: expect.any(String), toBlock: expect.any(String) },
      network: { chainId: 8453, fromBlock: expect.any(String), toBlock: expect.any(String) },
    } });

    const finance = await get('finance/analytics', '?range=all&interval=day');
    expect(finance.status).toBe(200);
    expect(await finance.json()).toMatchObject({ historySource: 'neon', strategy: { attribution: 'shared_unitas_strategy' } });
    const network = await get('network/analytics', '?range=7d');
    expect(network.status).toBe(200);
    expect(await network.json()).toMatchObject({ historySource: 'neon', analytics: { domain: 'network' } });
  });

  it('uses the existing bounded repository views without exposing proof or participant fields', async () => {
    const task = snapshot.network.events.find(event => event.taskId !== null)!.taskId!;
    const network = await get(`network/tasks/8453/${snapshot.network.taskContract}/${task}`);
    expect(network.status).toBe(200);
    const networkText = await network.text();
    expect(networkText).toContain('"historySource":"neon"');
    expect(networkText).not.toMatch(/proof|participant|signature/i);

    const batch = snapshot.finance.events.find(event => event.batchId)!;
    const finance = await get(`finance/batches/${batch.contractAddress}/${batch.batchId}`);
    expect(finance.status).toBe(200);
    expect(await finance.json()).toMatchObject({ historySource: 'neon', batchId: batch.batchId });
    expect(await (await get('unsupported')).json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(await (await get('overview', '?privateKey=secret')).json()).toMatchObject({ code: 'INVALID_QUERY' });
  });

  it('returns sanitized availability errors and exposes no write handler', async () => {
    historyRead.mockRejectedValueOnce(new Error('postgres://private-user:secret@private-host/database'));
    const response = await get('overview');
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('private-user');
    expect(body).not.toContain('private-host');
    expect(Object.hasOwn(await import('./route'), 'POST')).toBe(false);
  });
});
