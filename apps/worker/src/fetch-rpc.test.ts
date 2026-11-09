import { describe, expect, it, vi } from 'vitest';
import { FetchRpc } from './fetch-rpc';
import { WorkerError } from './registry';

const endpoint = 'https://bsc-rpc.publicnode.com';
const limits = { maxRequests: 1, maxSeconds: 5, timeoutSeconds: 1, maxResponseBytes: 1024, minIntervalMs: 0 };
function response(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}
function code(promise: Promise<unknown>) {
  return promise.catch(error => {
    expect(error).toBeInstanceOf(WorkerError);
    return (error as WorkerError).code;
  });
}

describe('FetchRpc', () => {
  it('accepts only registered provider endpoints and validates finite budgets', () => {
    expect(() => new FetchRpc('https://attacker.example', limits)).toThrowError('UNREGISTERED_RPC_ENDPOINT');
    expect(() => new FetchRpc(endpoint, { ...limits, maxRequests: 1001 })).toThrowError('INVALID_LIMITS');
  });

  it('enforces the request budget and permits only registered read methods', async () => {
    const fetcher = vi.fn(async () => response('{"jsonrpc":"2.0","id":1,"result":"0x38"}'));
    const rpc = new FetchRpc(endpoint, limits, fetcher as typeof fetch);
    await expect(rpc.call('eth_chainId', [])).resolves.toBe('0x38');
    expect(await code(rpc.call('eth_sendRawTransaction', ['private']))).toBe('INVALID_RPC_METHOD');
    expect(await code(rpc.call('eth_chainId', []))).toBe('REQUEST_BUDGET_EXHAUSTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized request and response bodies', async () => {
    const requestRpc = new FetchRpc(endpoint, { ...limits, maxRequests: 2 }, vi.fn() as typeof fetch);
    expect(await code(requestRpc.call('eth_getLogs', [{ data: 'x'.repeat(100_000) }]))).toBe('RPC_REQUEST_TOO_LARGE');
    const responseRpc = new FetchRpc(endpoint, { ...limits, maxResponseBytes: 8 },
      vi.fn(async () => response('{"jsonrpc":"2.0","id":1,"result":0}')) as typeof fetch);
    expect(await code(responseRpc.call('eth_chainId', []))).toBe('RESPONSE_TOO_LARGE');
  });

  it('classifies rate limits and strips provider details from transport errors', async () => {
    const limited = new FetchRpc(endpoint, limits,
      vi.fn(async () => response('busy', 429, { 'retry-after': '12' })) as typeof fetch);
    await expect(limited.call('eth_chainId', [])).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 12 });

    const secret = 'provider-secret-detail';
    const failed = new FetchRpc(endpoint, limits, vi.fn(async () => { throw new Error(secret); }) as typeof fetch);
    try {
      await failed.call('eth_chainId', []);
      throw new Error('expected transport failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RPC_TRANSPORT_ERROR' });
      expect(String(error)).not.toContain(secret);
    }
  });
});
