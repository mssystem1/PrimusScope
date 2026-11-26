import { hexQuantity, WorkerError } from './registry';
import type { Rpc } from './rpc';

export const SENTIO_BSC_RPC = 'https://bsc.rpc.sentio.xyz';

const PROVIDER_BLOCK_LIMIT = 1_000n;
const MAX_RANGE_BLOCKS = 100_000n;
const MAX_LOGS = 1_000;
const MAX_RESULT_BYTES = 2_000_000;

export class StrategyArchiveRpc implements Rpc {
  constructor(private readonly rpc: Rpc) {}

  get requestsMade(): number {
    return this.rpc.requestsMade;
  }

  async call(method: string, params: unknown[]): Promise<unknown> {
    if (method !== 'eth_getLogs') return this.rpc.call(method, params);

    const [input] = params;
    if (params.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) || 'blockHash' in input) {
      throw new WorkerError('FLOW_ARCHIVE_INVALID_RANGE');
    }
    const filter = input as Record<string, unknown>;
    const from = hexQuantity(filter.fromBlock);
    const to = hexQuantity(filter.toBlock);
    if (to < from || to - from + 1n > MAX_RANGE_BLOCKS) {
      throw new WorkerError('FLOW_ARCHIVE_INVALID_RANGE');
    }

    const logs: unknown[] = [];
    let bytes = 2; // JSON array brackets.
    for (let start = from; start <= to; start += PROVIDER_BLOCK_LIMIT) {
      const limit = start + PROVIDER_BLOCK_LIMIT - 1n;
      const end = limit < to ? limit : to;
      const result = await this.rpc.call(method, [{ ...filter,
        fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
      if (!Array.isArray(result)) throw new WorkerError('INVALID_RPC_RESPONSE');
      if (logs.length + result.length > MAX_LOGS) throw new WorkerError('RESPONSE_TOO_LARGE', true);
      if (result.length === 0) continue;

      let json: string;
      try { json = JSON.stringify(result); }
      catch { throw new WorkerError('INVALID_RPC_RESPONSE'); }
      bytes += Buffer.byteLength(json) - 2 + (logs.length > 0 ? 1 : 0);
      if (bytes > MAX_RESULT_BYTES) throw new WorkerError('RESPONSE_TOO_LARGE', true);
      logs.push(...result);
    }
    return logs;
  }
}
