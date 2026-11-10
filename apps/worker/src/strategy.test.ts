import { describe, expect, it, vi } from 'vitest';
import { getEventSelector, toFunctionSelector } from 'viem';
import { FinanceStrategySchema } from '@primusscope/api-schema';
import baselineData from '../../../data/strategy/unitas-history.json';
import type { Rpc } from './rpc';
import { mergeStrategySamples, projectStrategyFlowLog, strategyFlowStart, collectPublicStrategy } from './strategy';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const pins: Record<string, string> = {
    '6001': '18808e7e12c9fbc460bbd2d0098955b0a78629568f355c18c16e9f175c14fbcb',
    '6002': '63100f54260009276f2b8c73d3941f110dfffc1f8d5ef3a49a853f3712c0bf6d',
    '6003': 'fc837e6985f76ecc6325d3334a2e1aa63e7259f883a8cbb3a92f0cbde3600f73',
    '6004': '00fa8d946d05f35c22b3562125c4651f4540856ea51aa0d0e00056c671d14634',
  };
  return { ...actual, createHash: (algorithm: string) => {
    let content = '';
    return { update(value: Uint8Array) { content = Buffer.from(value).toString('hex'); return this; },
      digest(encoding?: string) {
        const pinned = algorithm === 'sha256' ? pins[content] : undefined;
        if (pinned) return encoding === 'hex' ? pinned : Buffer.from(pinned, 'hex');
        const hash = actual.createHash(algorithm); hash.update(Buffer.from(content, 'hex'));
        return encoding === 'hex' ? hash.digest('hex') : hash.digest();
      } };
  } };
});

const baseline = FinanceStrategySchema.parse(baselineData);
const word = (value: bigint) => value.toString(16).padStart(64, '0');
function mockRpc(run: (method: string, params: unknown[]) => unknown | Promise<unknown>): Rpc {
  let requestsMade = 0;
  return { get requestsMade() { return requestsMade; }, async call(method, params) { requestsMade++; return run(method, params); } };
}
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const header = { number: '0x64', hash: hash('a'), parentHash: hash('b'), timestamp: '0x69000000' };

describe('public strategy collector', () => {
  it('refuses a non-BSC stock RPC before making other requests', async () => {
    const rpc = mockRpc(method => { if (method === 'eth_chainId') return '0x1'; throw new Error('unexpected'); });
    await expect(collectPublicStrategy(baseline, { stockRpc: rpc, flowRpc: mockRpc(() => null) })).rejects.toMatchObject({ code: 'STRATEGY_WRONG_CHAIN' });
    expect(rpc.requestsMade).toBe(1);
  });

  it('rejects stock values when fixed runtime code pins do not match', async () => {
    const rpc = mockRpc((method, params) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') return header;
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}8d5e94c1eaae7d71ed4fcba2402e6b03380354f8`;
      if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        const output = new Map([
          [toFunctionSelector('staked()'), `0x${'0'.repeat(24)}385c279445581a186a4182a5503094ebb652ec71`],
          [toFunctionSelector('usdu()'), `0x${'0'.repeat(24)}ea953ea6634d55dac6697c436b1e81a679db5882`],
          [toFunctionSelector('decimals()'), `0x${word(18n)}`],
          [toFunctionSelector('totalAssets()'), `0x${word(100n)}`],
          [toFunctionSelector('totalSupply()'), `0x${word(100n)}`],
          [toFunctionSelector('getUnvestedAmount()'), `0x${word(0n)}`],
          [toFunctionSelector('convertToAssets(uint256)'), `0x${word(10n ** 18n)}`],
          [toFunctionSelector('calculateExchangeRate(uint256)'), `0x${word(10n ** 18n)}`],
          [toFunctionSelector('balanceOf(address)'), `0x${word(100n)}`],
        ]);
        return output.get(data.slice(0, 10) as `0x${string}`) ?? `0x${word(0n)}`;
      }
      throw new Error('unexpected method');
    });
    await expect(collectPublicStrategy(baseline, { stockRpc: rpc, flowRpc: mockRpc(() => null) })).rejects.toMatchObject({ code: 'STRATEGY_CODE_CHANGED' });
  });

  it('collects a fresh stock snapshot with every call pinned to the finalized block and intended contract', async () => {
    const freshHeader={...header,number:'0x'+(BigInt(baseline.samples.at(-1)!.blockNumber)+1n).toString(16),
      timestamp:'0x'+BigInt(Date.parse(baseline.samples.at(-1)!.timestamp)/1000+1).toString(16)};
    const called: { to: string; block: string; selector: string }[] = [];
    const expectedAddress = new Map([
      [toFunctionSelector('staked()'), '0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae'],
      [toFunctionSelector('usdu()'), '0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae'],
      [toFunctionSelector('decimals()'), 'either-decimals'],
      [toFunctionSelector('totalAssets()'), '0x385c279445581a186a4182a5503094ebb652ec71'],
      [toFunctionSelector('totalSupply()'), '0x385c279445581a186a4182a5503094ebb652ec71'],
      [toFunctionSelector('getUnvestedAmount()'), '0x385c279445581a186a4182a5503094ebb652ec71'],
      [toFunctionSelector('convertToAssets(uint256)'), '0x385c279445581a186a4182a5503094ebb652ec71'],
      [toFunctionSelector('calculateExchangeRate(uint256)'), '0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae'],
      [toFunctionSelector('balanceOf(address)'), '0xea953ea6634d55dac6697c436b1e81a679db5882'],
    ]);
    const stockRpc = mockRpc((method, params) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') return freshHeader;
      if (method === 'eth_getCode') {
        const to = params[0] as string;
        return to === '0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae' ? '0x6001'
          : to === '0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8' ? '0x6002'
            : to === '0x385c279445581a186a4182a5503094ebb652ec71' ? '0x6003' : '0x6004';
      }
      if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}8d5e94c1eaae7d71ed4fcba2402e6b03380354f8`;
      if (method === 'eth_call') {
        const request = params[0] as { to: string; data: string };
        const block = params[1] as string, selector = request.data.slice(0, 10);
        called.push({ to: request.to, block, selector });
        expect(block).toBe(freshHeader.number);
        const recipient = expectedAddress.get(selector as `0x${string}`);
        if (recipient === 'either-decimals') expect(['0xea953ea6634d55dac6697c436b1e81a679db5882', '0x385c279445581a186a4182a5503094ebb652ec71']).toContain(request.to);
        else expect(request.to).toBe(recipient);
        if (selector === toFunctionSelector('staked()')) return `0x${'0'.repeat(24)}385c279445581a186a4182a5503094ebb652ec71`;
        if (selector === toFunctionSelector('usdu()')) return `0x${'0'.repeat(24)}ea953ea6634d55dac6697c436b1e81a679db5882`;
        if (selector === toFunctionSelector('decimals()')) return `0x${word(18n)}`;
        if (selector === toFunctionSelector('totalAssets()')) return `0x${word(90n)}`;
        if (selector === toFunctionSelector('totalSupply()')) return `0x${word(90n)}`;
        if (selector === toFunctionSelector('getUnvestedAmount()')) return `0x${word(10n)}`;
        if (selector === toFunctionSelector('balanceOf(address)')) return `0x${word(100n)}`;
        return `0x${word(10n ** 18n)}`;
      }
      throw new Error('unexpected method');
    });
    const flowRpc = mockRpc(method => { if (method === 'eth_chainId') return '0x1'; throw new Error('unexpected'); });
    const result = await collectPublicStrategy(baseline, { stockRpc, flowRpc, now: () => new Date('2026-11-10T07:00:00.000Z') });
    expect(result.flowIssueCode).toBe('FLOW_WRONG_CHAIN');
    expect(result.strategy.flowCoverage).toEqual(baseline.flowCoverage);
    expect(result.strategy).toMatchObject({ proxyAddress: '0xe9E8573Bb351da16c6EE7DDaC0cBC70b7f9784AE',
      vaultAddress: '0x385c279445581a186a4182a5503094ebb652ec71', assetAddress: '0xea953ea6634d55dac6697c436b1e81a679db5882',
      assetSymbol: 'USDu', shareSymbol: 'sUSDu', assetDecimals: 18, shareDecimals: 18 });
    expect(result.strategy.samples.at(-1)).toMatchObject({ blockNumber: String(BigInt(freshHeader.number)), totalAssetsRaw: '90', totalSupplyRaw: '90', unvestedRaw: '10' });
    expect(called).toHaveLength(10);
    freshHeader.number='0x64';freshHeader.timestamp=header.timestamp;
    await expect(collectPublicStrategy(baseline,{stockRpc,flowRpc})).rejects.toMatchObject({code:'STRATEGY_HEAD_BEHIND'});
  });

  it('projects standard ERC-4626 event amounts without retaining participants', () => {
    const topic = getEventSelector({ type: 'event', name: 'Deposit', inputs: [
      { type: 'address', name: 'sender', indexed: true }, { type: 'address', name: 'owner', indexed: true },
      { type: 'uint256', name: 'assets', indexed: false }, { type: 'uint256', name: 'shares', indexed: false },
    ] });
    const projected = projectStrategyFlowLog({ address: baseline.vaultAddress, removed: false,
      topics: [topic, `0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`], data: `0x${word(123n)}${word(120n)}`,
      blockNumber: '0x64', blockHash: hash('a'), transactionHash: hash('c'), logIndex: '0x0' }, 100n);
    expect(projected).toMatchObject({ kind: 'Deposit', assetsRaw: '123', sharesRaw: '120', blockNumber: '100' });
    expect(Object.keys(projected)).not.toContain('sender');
    expect(Object.keys(projected)).not.toContain('owner');
    expect(() => projectStrategyFlowLog({ address: baseline.vaultAddress, removed: false, topics: [topic], data: '0x',
      blockNumber: '0x64', blockHash: hash('a'), transactionHash: hash('c'), logIndex: '0x0' }, 100n)).toThrow();
  });

  it('keeps one sample per UTC hour within 90 days and never backfills incomplete flow coverage', () => {
    const latest = { ...baseline.samples.at(-1)!, blockNumber: '999999999', timestamp: '2026-11-10T06:30:00.000Z' };
    const replaced = { ...latest, blockNumber: '999999998', timestamp: '2026-11-10T06:05:00.000Z' };
    const expired = { ...latest, blockNumber: '1', timestamp: '2026-01-01T00:00:00.000Z' };
    const samples = mergeStrategySamples([expired, replaced], [latest]);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.blockNumber).toBe('999999999');
    const prior = structuredClone(baseline);
    prior.flowCoverage = { fromBlock: '10', toBlock: '20', fromTime: '2026-11-09T00:00:00.000Z',
      toTime: '2026-11-09T01:00:00.000Z', observedAt: '2026-11-09T01:00:00.000Z',
      sourceUrl: 'https://bsc-rpc.publicnode.com', complete: false };
    expect(strategyFlowStart(prior, 123n)).toBe(123n);
    prior.flowCoverage = { ...prior.flowCoverage, complete: true, toBlock: '122' };
    expect(strategyFlowStart(prior, 200n)).toBe(123n);
  });
});
