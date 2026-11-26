import { describe, expect, it, vi } from 'vitest';
import type { Rpc } from './rpc';
import { StrategyArchiveRpc } from './strategy-archive-rpc';

const address = '0x385c279445581a186a4182a5503094ebb652ec71';
const topics = [[`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`]];
const filter = { address, topics, fromBlock: '0x64', toBlock: '0xa28' };

function archiveWith(...responses: unknown[]) {
  let index = 0;
  const call = vi.fn<Rpc['call']>(async () => responses[index++]);
  const rpc = new StrategyArchiveRpc({ call, get requestsMade() { return call.mock.calls.length; } });
  return { rpc, call };
}

describe('StrategyArchiveRpc', () => {
  it('splits 2501 blocks sequentially and preserves log filters and ordering', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const { rpc, call } = archiveWith(first, [{ id: 'second' }], [{ id: 'third' }]);
    const pending = rpc.call('eth_getLogs', [filter]);
    expect(rpc.requestsMade).toBe(1);
    resolveFirst([{ id: 'first' }]);

    await expect(pending).resolves.toEqual([{ id: 'first' }, { id: 'second' }, { id: 'third' }]);
    expect(call.mock.calls).toEqual([
      ['eth_getLogs', [{ ...filter, fromBlock: '0x64', toBlock: '0x44b' }]],
      ['eth_getLogs', [{ ...filter, fromBlock: '0x44c', toBlock: '0x833' }]],
      ['eth_getLogs', [{ ...filter, fromBlock: '0x834', toBlock: '0xa28' }]],
    ]);
    expect(rpc.requestsMade).toBe(3);
  });

  it('delegates non-log methods unchanged', async () => {
    const { rpc, call } = archiveWith('0x38');
    await expect(rpc.call('eth_chainId', [])).resolves.toBe('0x38');
    expect(call).toHaveBeenCalledExactlyOnceWith('eth_chainId', []);
    expect(rpc.requestsMade).toBe(1);
  });

  it.each([
    [],
    [null],
    [{ fromBlock: 'latest', toBlock: '0x64' }],
    [{ fromBlock: '0x0' }],
    [{ fromBlock: '0x01', toBlock: '0x64' }],
    [{ fromBlock: 1, toBlock: '0x64' }],
    [{ fromBlock: '0x65', toBlock: '0x64' }],
    [{ fromBlock: '0x0', toBlock: '0x186a0' }],
    [{ ...filter, blockHash: `0x${'a'.repeat(64)}` }],
  ].map(params => ({ params })))('rejects invalid range $params before querying', async ({ params }) => {
    const { rpc, call } = archiveWith();
    await expect(rpc.call('eth_getLogs', params)).rejects.toMatchObject({ name: 'WorkerError' });
    expect(call).not.toHaveBeenCalled();
  });

  it('fails the complete read if a subquery returns an invalid result', async () => {
    const { rpc, call } = archiveWith([], { logs: [] });
    await expect(rpc.call('eth_getLogs', [filter])).rejects.toMatchObject({ code: 'INVALID_RPC_RESPONSE' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('enforces the aggregate log count', async () => {
    const logs = Array.from({ length: 500 }, () => ({ address }));
    const fitting = archiveWith(logs, logs, []);
    await expect(fitting.rpc.call('eth_getLogs', [filter])).resolves.toHaveLength(1000);

    const overflow = archiveWith(logs, [...logs, { address }], []);
    await expect(overflow.rpc.call('eth_getLogs', [filter])).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(overflow.call).toHaveBeenCalledTimes(2);
  });

  it('enforces UTF-8 size of the merged JSON array including separators', async () => {
    const first = ['é'.repeat(499_998)];
    const second = ['é'.repeat(499_998) + 'a'];
    const fitting = archiveWith(first, second, []);
    await expect(fitting.rpc.call('eth_getLogs', [filter])).resolves.toHaveLength(2);

    const overflow = archiveWith(first, [second[0] + 'b'], []);
    await expect(overflow.rpc.call('eth_getLogs', [filter])).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(overflow.call).toHaveBeenCalledTimes(2);
  });
});
