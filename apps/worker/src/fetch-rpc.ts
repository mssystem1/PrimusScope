import { WorkerError } from './registry';
import { DEFAULT_RPC_LIMITS, type Rpc, type RpcLimits } from './rpc';

const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionReceipt', 'eth_call']);
const endpoints = new Set(['https://bsc-rpc.publicnode.com', 'https://base-rpc.publicnode.com', 'https://bsc-mainnet.public.blastapi.io']);

/** Serverless transport: native HTTPS, finite budgets, no child processes or raw response retention. */
export class FetchRpc implements Rpc {
  requestsMade = 0;
  private readonly deadline: number;
  private lastStarted = 0;
  constructor(private readonly endpoint: string, private readonly limits: RpcLimits = DEFAULT_RPC_LIMITS,
    private readonly request: typeof fetch = fetch) {
    if (!endpoints.has(endpoint)) throw new WorkerError('UNREGISTERED_RPC_ENDPOINT');
    if (!Number.isInteger(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 1000
      || !Number.isInteger(limits.maxSeconds) || limits.maxSeconds < 1 || limits.maxSeconds > 600
      || limits.timeoutSeconds < 1 || limits.timeoutSeconds > 30 || limits.maxResponseBytes < 1
      || limits.maxResponseBytes > 5_000_000 || limits.minIntervalMs < 0 || limits.minIntervalMs > 5000) {
      throw new WorkerError('INVALID_LIMITS');
    }
    this.deadline = Date.now() + limits.maxSeconds * 1000;
  }
  async call(method: string, params: unknown[]): Promise<unknown> {
    if (!methods.has(method) || !Array.isArray(params)) throw new WorkerError('INVALID_RPC_METHOD');
    if (this.requestsMade >= this.limits.maxRequests) throw new WorkerError('REQUEST_BUDGET_EXHAUSTED');
    const delay = Math.max(0, this.lastStarted + this.limits.minIntervalMs - Date.now());
    if (Date.now() + delay + this.limits.timeoutSeconds * 1000 >= this.deadline) throw new WorkerError('RUN_DEADLINE_EXHAUSTED');
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    this.lastStarted = Date.now(); const id = ++this.requestsMade;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(payload) > 100_000) throw new WorkerError('RPC_REQUEST_TOO_LARGE');
    try {
      const response = await this.request(this.endpoint, { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json' }, body: payload,
        signal: AbortSignal.timeout(this.limits.timeoutSeconds * 1000) });
      const retry = response.headers.get('retry-after');
      const retryAfter = retry && /^\d{1,6}$/.test(retry) && Number(retry) <= 86400 ? Number(retry) : undefined;
      if (response.status === 429) throw new WorkerError('RATE_LIMITED', false, retryAfter);
      if (response.status >= 300 && response.status < 400) throw new WorkerError('REDIRECT_REFUSED');
      const reader = response.body?.getReader();
      if (!reader) throw new WorkerError('INVALID_RPC_RESPONSE');
      let length = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > this.limits.maxResponseBytes) { await reader.cancel(); throw new WorkerError('RESPONSE_TOO_LARGE', true); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      if (response.status === 403) throw new WorkerError(/archive/i.test(text) ? 'RPC_ARCHIVE_UNAVAILABLE' : 'HTTP_FORBIDDEN');
      if (response.status >= 500) throw new WorkerError('HTTP_SERVER_ERROR');
      if (response.status !== 200) throw new WorkerError('RPC_TRANSPORT_ERROR');
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new WorkerError('INVALID_RPC_RESPONSE'); }
      if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== id
        || Object.hasOwn(parsed, 'error') === Object.hasOwn(parsed, 'result')) throw new WorkerError('INVALID_RPC_RESPONSE');
      if (Object.hasOwn(parsed, 'error')) {
        if (!parsed.error || typeof parsed.error.code !== 'number' || typeof parsed.error.message !== 'string') throw new WorkerError('INVALID_RPC_RESPONSE');
        const message = parsed.error.message.toLowerCase();
        if (/rate limit|too many requests|quota|credits?|daily limit|monthly limit|request limit/.test(message)) throw new WorkerError('RATE_LIMITED', false, retryAfter);
        if (/archive/.test(message)) throw new WorkerError('RPC_ARCHIVE_UNAVAILABLE');
        if (/block range|too many results|response size|query returned more|range too large/.test(message)) throw new WorkerError('RPC_RANGE_LIMIT', true);
        throw new WorkerError('RPC_ERROR');
      }
      return parsed.result;
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'REQUEST_TIMEOUT' : 'RPC_TRANSPORT_ERROR',
        error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
    }
  }
}
