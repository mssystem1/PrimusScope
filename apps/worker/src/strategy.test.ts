import { describe, expect, it, vi } from 'vitest';
import { getEventSelector, toFunctionSelector } from 'viem';
import { FinanceStrategySchema } from '@primusscope/api-schema';
import { WorkerError } from './registry';
import baselineData from '../../../data/strategy/unitas-history.json';
import type { Rpc } from './rpc';
import { mergeStrategySamples, projectStrategyFlowLog, strategyFlowStart, collectPublicStrategy, collectStrategyStockSampleAt, collectStrategyFlows, reconcileStrategyFlowShares, mergeStrategyLogReads, reconcileStrategyLogReads } from './strategy';

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
function historicalStockRpc(blockNumber: string, options: { codeChanged?: boolean; headerChanged?: boolean; timestamp?: string; block?: bigint;
  stockSupply?: bigint; boundaryBlock?: bigint; boundarySupply?: bigint;
  anchorHeader?: () => { number: bigint; hash: string; timestamp: string } | undefined;
  extraHeaders?: () => { number: bigint; hash: string; timestamp: string }[];
  extraLogs?: (filter: Record<string, unknown>) => unknown } = {}) {
  const sample = baseline.samples.find(item => item.blockNumber === blockNumber)!;
  const blockTag = `0x${(options.block ?? BigInt(blockNumber)).toString(16)}`;
  const sampleTimestamp = options.timestamp ?? sample.timestamp;
  const sampleHeader = { number: blockTag, hash: options.block ? hash('e') : sample.blockHash, parentHash: hash('b'), timestamp: `0x${Math.floor(Date.parse(sampleTimestamp) / 1000).toString(16)}` };
  let headerReads = 0;
  const requestedTags: unknown[] = [];
  const rpc = mockRpc((method, params) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') {
      requestedTags.push(params[0]);
      headerReads++;
      const anchor = options.anchorHeader?.();
      const tag = params[0];
      const extra = options.extraHeaders?.().find(item => tag === `0x${item.number.toString(16)}`);
      const matching = anchor && tag === `0x${anchor.number.toString(16)}` ? anchor : extra;
      const found = matching ? { number: tag, hash: matching.hash, parentHash: hash('b'),
        timestamp: `0x${Math.floor(Date.parse(matching.timestamp) / 1000).toString(16)}` } : sampleHeader;
      return options.headerChanged && headerReads === 2 ? { ...found, hash: hash('f') } : found;
    }
    if (method === 'eth_getCode') {
      const to = params[0] as string;
      const code = to === '0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae' ? '0x6001'
        : to === '0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8' ? '0x6002'
          : to === '0x385c279445581a186a4182a5503094ebb652ec71' ? options.codeChanged ? '0x6999' : '0x6003' : '0x6004';
      return code;
    }
    if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}8d5e94c1eaae7d71ed4fcba2402e6b03380354f8`;
    if (method === 'eth_getLogs' && options.extraLogs) return options.extraLogs(params[0] as Record<string, unknown>);
    if (method === 'eth_call') {
      const selector = (params[0] as { data: string }).data.slice(0, 10);
      const output = new Map([
        [toFunctionSelector('staked()'), `0x${'0'.repeat(24)}385c279445581a186a4182a5503094ebb652ec71`],
        [toFunctionSelector('usdu()'), `0x${'0'.repeat(24)}ea953ea6634d55dac6697c436b1e81a679db5882`],
        [toFunctionSelector('decimals()'), `0x${word(18n)}`],
        [toFunctionSelector('totalAssets()'), `0x${word(options.stockSupply ?? 90n)}`],
        [toFunctionSelector('totalSupply()'), `0x${word(options.boundaryBlock !== undefined && params[1] === `0x${options.boundaryBlock.toString(16)}`
          ? options.boundarySupply ?? options.stockSupply ?? 90n : options.stockSupply ?? 90n)}`],
        [toFunctionSelector('getUnvestedAmount()'), `0x${word(options.stockSupply === undefined ? 10n : 0n)}`],
        [toFunctionSelector('convertToAssets(uint256)'), `0x${word(10n ** 18n)}`],
        [toFunctionSelector('calculateExchangeRate(uint256)'), `0x${word(10n ** 18n)}`],
        [toFunctionSelector('balanceOf(address)'), `0x${word(options.stockSupply ?? 100n)}`],
      ]);
      return output.get(selector as `0x${string}`) ?? `0x${word(0n)}`;
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { rpc, requestedTags, blockTag };
}

describe('public strategy collector', () => {
  it.each([
    { distance:15000n, failSecond:false, advance:15000n },
    { distance:15000n, failSecond:true, advance:10000n },
    { distance:25000n, failSecond:false, advance:20000n },
  ])('bounds catch-up and retains validated progress (later failure: $failSecond, distance: $distance)', async ({distance,failSecond,advance}) => {
    const prior=structuredClone(baseline), old=prior.flowCoverage!, boundary=BigInt(old.toBlock), target=boundary+distance;
    const headers=[{number:boundary,hash:old.toBlockHash!,timestamp:old.toTime},
      {number:boundary+10000n,hash:hash('c'),timestamp:'2026-11-10T07:30:00.000Z'},
      {number:boundary+20000n,hash:hash('d'),timestamp:'2026-11-10T08:30:00.000Z'},
      {number:target,hash:hash('e'),timestamp:'2026-11-10T09:30:00.000Z'}];
    const stock=historicalStockRpc(prior.samples.at(-1)!.blockNumber,{block:target,timestamp:headers.at(-1)!.timestamp,
      stockSupply:90n,boundaryBlock:boundary,boundarySupply:90n,extraHeaders:()=>headers.slice(0,-1)});
    const starts:bigint[]=[];
    const flow=mockRpc((method,params)=>{
      if(method==='eth_chainId')return '0x38';
      if(method==='eth_getBlockByNumber'){
        const found=headers.find(h=>h.number===BigInt(params[0] as string));
        if(!found)throw new Error('Optional rolling anchor unavailable');
        return {number:params[0],hash:found.hash,parentHash:hash('b'),timestamp:'0x'+Math.floor(Date.parse(found.timestamp)/1000).toString(16)};
      }
      if(method==='eth_getLogs'){
        const from=BigInt((params[0] as {fromBlock:string}).fromBlock);starts.push(from);
        if(failSecond&&from>boundary+10000n)throw new WorkerError('RATE_LIMITED');
        return [];
      }
      throw new Error('Unexpected receipt read for empty ranges');
    });
    const result=await collectPublicStrategy(prior,{stockRpc:stock.rpc,flowRpc:flow});
    expect(result.strategy.flowCoverage?.toBlock).toBe(String(boundary+advance));
    expect(result.strategy.flows).toEqual(prior.flows);
    expect(result.strategy.samples.at(-1)?.blockNumber).toBe(String(target));
    expect(result.flowIssueCode).toBe(failSecond?'FLOW_RATE_LIMITED':undefined);
    expect([...new Set(starts)]).toEqual([boundary+1n,boundary+10001n]);
  });
  it.each([false,true])('refuses archive recovery without a verifiable retained event (empty history: %s)', async emptyHistory => {
    const prior = structuredClone(baseline), boundary = prior.flowCoverage!;
    if(emptyHistory)prior.flows=[];
    const stock = { ...prior.samples.at(-1)!, blockNumber: String(BigInt(boundary.toBlock) + 1n),
      blockHash: hash('e'), timestamp: '2026-11-10T06:30:00.000Z' };
    let accountingReads = 0, logReads = 0;
    const rpc = mockRpc((method, params) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') {
        const atBoundary = BigInt(params[0] as string) === BigInt(boundary.toBlock);
        return { number: params[0], hash: atBoundary ? boundary.toBlockHash : stock.blockHash, parentHash: hash('b'),
          timestamp: `0x${Math.floor(Date.parse(atBoundary ? boundary.toTime : stock.timestamp) / 1000).toString(16)}` };
      }
      if (method === 'eth_getLogs') { logReads++; return []; }
      throw new Error('No receipt or accounting read should follow a missing archive anchor');
    });
    const accounting = mockRpc(() => { accountingReads++; throw new Error('Unexpected accounting read'); });
    await expect(collectStrategyFlows(rpc, stock, prior, () => new Date(), accounting,
      { sourceUrl: 'https://bsc.rpc.sentio.xyz' })).rejects.toMatchObject({ code: 'FLOW_ARCHIVE_ANCHOR_MISSING' });
    expect(logReads).toBe(emptyHistory?0:1); expect(accountingReads).toBe(0);
    expect(prior.flowCoverage).toEqual(baseline.flowCoverage);
    expect(prior.flows).toEqual(emptyHistory?[]:baseline.flows);
  });
  it('checks canonical boundary evidence while preserving legacy retained flow IDs', async () => {
    const prior = structuredClone(baseline), boundary = prior.flowCoverage!, sentinel = prior.flows.at(-1)!;
    const stock = { ...prior.samples.at(-1)!, blockNumber: String(BigInt(boundary.toBlock) + 1n),
      blockHash: hash('e'), timestamp: '2026-11-10T06:30:00.000Z', totalSupplyRaw: '90' };
    const topic = getEventSelector(sentinel.kind === 'Deposit' ? 'Deposit(address,address,uint256,uint256)' : 'Withdraw(address,address,address,uint256,uint256)');
    const retainedLog = { address: prior.vaultAddress, removed: false, topics: [topic,hash('0'),hash('0'),...(sentinel.kind === 'Withdraw'?[hash('0')]:[])],
      data: '0x'+word(BigInt(sentinel.assetsRaw))+word(BigInt(sentinel.sharesRaw)), blockNumber:'0x'+BigInt(sentinel.blockNumber).toString(16),
      blockHash:sentinel.blockHash,transactionHash:sentinel.transactionHash,logIndex:'0x'+BigInt(sentinel.logIndex).toString(16) };
    const rpc = mockRpc((method, params) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') {
        const atBoundary = BigInt(params[0] as string) === BigInt(boundary.toBlock);
        return { number: params[0], hash: atBoundary ? boundary.toBlockHash : stock.blockHash, parentHash: hash('b'),
          timestamp: `0x${Math.floor(Date.parse(atBoundary ? boundary.toTime : stock.timestamp) / 1000).toString(16)}` };
      }
      if (method === 'eth_getLogs') return (params[0] as {fromBlock:string}).fromBlock === retainedLog.blockNumber ? [retainedLog] : [];
      throw new Error('Unexpected receipt read for an empty new range');
    });
    const accounting = mockRpc((method, params) => method === 'eth_getBlockByNumber'
      ? { number: params[0],hash:boundary.toBlockHash,parentHash:hash('b'),timestamp:'0x'+Math.floor(Date.parse(boundary.toTime)/1000).toString(16) }
      : '0x'+word(90n));
    const result = await collectStrategyFlows(rpc,stock,prior,()=>new Date(),accounting,{sourceUrl:'https://bsc.rpc.sentio.xyz'});
    expect(result.flowCoverage?.toBlock).toBe(stock.blockNumber);
    expect(result.flowCoverage?.sourceUrl).toBe('https://bsc.rpc.sentio.xyz');
    expect(result.flows).toEqual(prior.flows);
    expect(result.flows.at(-1)!.id).toBe(sentinel.id);
  });
  it('samples a requested historical block with the same pins, accounting checks, and header recheck', async () => {
    const old = baseline.samples.find(sample => sample.blockNumber === '132716031')!;
    const { rpc, requestedTags, blockTag } = historicalStockRpc(old.blockNumber);
    const sample = await collectStrategyStockSampleAt(rpc, BigInt(old.blockNumber), () => new Date('2026-11-26T18:00:00.000Z'));
    expect(requestedTags).toEqual([blockTag, blockTag]);
    expect(sample).toMatchObject({ blockNumber: old.blockNumber, blockHash: old.blockHash, timestamp: old.timestamp,
      observedAt: '2026-11-26T18:00:00.000Z', totalAssetsRaw: '90', totalSupplyRaw: '90' });
    const changedCode = historicalStockRpc(old.blockNumber, { codeChanged: true });
    await expect(collectStrategyStockSampleAt(changedCode.rpc, BigInt(old.blockNumber))).rejects.toMatchObject({ code: 'STRATEGY_CODE_CHANGED' });
    const changedHeader = historicalStockRpc(old.blockNumber, { headerChanged: true });
    await expect(collectStrategyStockSampleAt(changedHeader.rpc, BigInt(old.blockNumber))).rejects.toMatchObject({ code: 'STRATEGY_BLOCK_CHANGED' });
  });

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
    expect(flowRpc.requestsMade).toBe(1);
    freshHeader.number='0x64';freshHeader.timestamp=header.timestamp;
    await expect(collectPublicStrategy(baseline,{stockRpc,flowRpc})).rejects.toMatchObject({code:'STRATEGY_HEAD_BEHIND'});
  });

  it('keeps the current sample and continues flow work when rolling-anchor lookup fails', async () => {
    const prior = structuredClone(baseline);
    const currentBlock = BigInt(prior.samples.at(-1)!.blockNumber) + 1n;
    const currentTime = '2026-11-10T07:00:00.000Z';
    const stock = historicalStockRpc(prior.samples.at(-1)!.blockNumber, { block: currentBlock, timestamp: currentTime });
    const flowRpc = mockRpc(method => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') throw new Error('historical header unavailable');
      throw new Error(`unexpected method ${method}`);
    });
    const result = await collectPublicStrategy(prior, { stockRpc: stock.rpc, flowRpc, now: () => new Date('2026-11-10T07:01:00.000Z') });
    expect(result.flowIssueCode).toBeUndefined();
    expect(result.strategy.samples.at(-1)).toMatchObject({ blockNumber: currentBlock.toString(), timestamp: currentTime });
    expect(result.strategy.flowCoverage).toEqual(prior.flowCoverage);
    expect(flowRpc.requestsMade).toBe(2);
  });

  it('adds a pinned rolling anchor while preserving existing and current samples', async () => {
    const prior = structuredClone(baseline);
    const currentBlock = BigInt(prior.samples.at(-1)!.blockNumber) + 1n;
    const currentTime = '2026-11-10T07:00:00.000Z';
    const targetTime = Date.parse(currentTime) - 30 * 86400_000;
    const ordered = [...prior.samples].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const lowSample = [...ordered].reverse().find(item => Date.parse(item.timestamp) < targetTime)!;
    const highSample = ordered.find(item => Date.parse(item.timestamp) > targetTime)!;
    let selectedHeader: { number: bigint; hash: string; timestamp: string } | undefined;
    const stock = historicalStockRpc(prior.samples.at(-1)!.blockNumber, { block: currentBlock, timestamp: currentTime,
      anchorHeader: () => selectedHeader });
    const flowRpc = mockRpc((method, params) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') {
        const number = BigInt(params[0] as string);
        const existing = ordered.find(item => BigInt(item.blockNumber) === number);
        if (existing) return { number: params[0], hash: existing.blockHash, parentHash: hash('b'), timestamp: `0x${Math.floor(Date.parse(existing.timestamp) / 1000).toString(16)}` };
        const lowBlock = BigInt(lowSample.blockNumber), highBlock = BigInt(highSample.blockNumber);
        const fraction = Number(number - lowBlock) / Number(highBlock - lowBlock);
        const seconds = Math.floor(Date.parse(lowSample.timestamp) / 1000
          + fraction * (Date.parse(highSample.timestamp) - Date.parse(lowSample.timestamp)) / 1000);
        const found = { number, hash: hash('c'), timestamp: new Date(seconds * 1000).toISOString() };
        selectedHeader = found;
        return { number: params[0], hash: found.hash, parentHash: hash('b'), timestamp: `0x${seconds.toString(16)}` };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const result = await collectPublicStrategy(prior, { stockRpc: stock.rpc, flowRpc, now: () => new Date('2026-11-10T07:01:00.000Z') });
    expect(result.flowIssueCode).toBeUndefined();
    expect(result.strategy.samples.some(item => item.timestamp === currentTime)).toBe(true);
    expect(result.strategy.samples.some(item => item.timestamp === prior.samples.at(-1)!.timestamp)).toBe(true);
    const anchor = result.strategy.samples.reduce((best, item) => Math.abs(Date.parse(item.timestamp) - targetTime)
      < Math.abs(Date.parse(best.timestamp) - targetTime) ? item : best, result.strategy.samples[0]!);
    expect(Math.abs(Date.parse(anchor.timestamp) - targetTime)).toBeLessThanOrEqual(2 * 3600_000);
    expect(anchor.blockHash).toBe(selectedHeader?.hash);
    expect(flowRpc.requestsMade).toBeGreaterThan(3);
  });

  it('rejects a secondary union above the event cap before receipt reads or coverage advances', async () => {
    const prior = structuredClone(baseline);
    const from = BigInt(prior.flowCoverage!.toBlock) + 1n;
    const target = from;
    const currentTime = '2026-11-10T06:45:00.000Z';
    const boundaryBlock = BigInt(prior.flowCoverage!.toBlock);
    const boundaryHeader = { number: boundaryBlock, hash: prior.flowCoverage!.toBlockHash!, timestamp: prior.flowCoverage!.toTime };
    const targetHeader = { number: target, hash: hash('e'), timestamp: currentTime };
    const events = Array.from({ length: 61 }, (_, index) => ({
      address: baseline.vaultAddress, removed: false,
      topics: [getEventSelector('Deposit(address,address,uint256,uint256)'), hash('1'), hash('2')],
      data: '0x' + word(1n) + word(1n), blockNumber: `0x${target.toString(16)}`, blockHash: targetHeader.hash,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}`, logIndex: `0x${index.toString(16)}`,
    }));
    const stock = historicalStockRpc(prior.samples.at(-1)!.blockNumber, { block: target, timestamp: currentTime,
      stockSupply: 161n, boundaryBlock, boundarySupply: 100n, extraHeaders: () => [boundaryHeader], extraLogs: () => events });
    let receiptReads = 0;
    const flowRpc = mockRpc((method, params) => {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_getBlockByNumber') {
        const block = BigInt(params[0] as string);
        const found = block === boundaryBlock ? boundaryHeader : block === target ? targetHeader : null;
        if (!found) throw new Error('unexpected block');
        return { number: `0x${block.toString(16)}`, hash: found.hash, parentHash: hash('b'),
          timestamp: `0x${Math.floor(Date.parse(found.timestamp) / 1000).toString(16)}` };
      }
      if (method === 'eth_getLogs') return events.slice(0, 1);
      if (method === 'eth_getTransactionReceipt') { receiptReads++; throw new Error('receipt should not be requested'); }
      throw new Error(`unexpected method ${method}`);
    });
    const result = await collectPublicStrategy(prior, { stockRpc: stock.rpc, flowRpc, now: () => new Date('2026-11-10T07:00:00.000Z') });
    expect(result.flowIssueCode).toBe('FLOW_EVENT_LIMIT');
    expect(result.strategy.flowCoverage).toEqual(prior.flowCoverage);
    expect(result.strategy.flows).toEqual(prior.flows);
    expect(receiptReads).toBe(0);
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


describe('flow read completeness controls',()=>{
  it('combines two differently filtered log reads without duplicating facts and refuses conflicts',()=>{
    const topic=getEventSelector('Deposit(address,address,uint256,uint256)');
    const first={address:baseline.vaultAddress,removed:false,topics:[topic,hash('1'),hash('2')],data:'0x'+word(10n)+word(9n),blockNumber:'0x64',blockHash:hash('a'),transactionHash:hash('c'),logIndex:'0x0'};
    const second={...first,transactionHash:hash('d'),logIndex:'0x1'};
    expect(mergeStrategyLogReads([[first],[first,second]],100n,100n)).toHaveLength(2);
    expect(()=>mergeStrategyLogReads([[first],[{...first,data:'0x'+word(11n)+word(9n)}]],100n,100n)).toThrow();
  });
  it('recovers a silently omitted flow only when a second source restores exact supply reconciliation',()=>{
    const depositTopic=getEventSelector('Deposit(address,address,uint256,uint256)');
    const withdrawTopic=getEventSelector('Withdraw(address,address,address,uint256,uint256)');
    const deposit={address:baseline.vaultAddress,removed:false,topics:[depositTopic,hash('1'),hash('2')],data:'0x'+word(20n)+word(20n),blockNumber:'0x64',blockHash:hash('a'),transactionHash:hash('c'),logIndex:'0x0'};
    const withdraw={address:baseline.vaultAddress,removed:false,topics:[withdrawTopic,hash('1'),hash('2'),hash('3')],data:'0x'+word(5n)+word(5n),blockNumber:'0x64',blockHash:hash('a'),transactionHash:hash('d'),logIndex:'0x1'};
    expect(()=>reconcileStrategyLogReads([[deposit],[],[withdraw]],100n,100n,100n,115n)).not.toThrow();
    expect(()=>reconcileStrategyLogReads([[deposit],[],[]],100n,100n,100n,115n)).toThrow('FLOW_SUPPLY_RECONCILIATION_FAILED');
  });
  it('rejects a silently incomplete flow set when on-chain share supply changed',()=>{
    expect(()=>reconcileStrategyFlowShares([{kind:'Deposit',sharesRaw:'20'},{kind:'Withdraw',sharesRaw:'5'}],100n,115n)).not.toThrow();
    expect(()=>reconcileStrategyFlowShares([{kind:'Withdraw',sharesRaw:'5'}],100n,115n)).toThrow('FLOW_SUPPLY_RECONCILIATION_FAILED');
    expect(()=>reconcileStrategyFlowShares([],100n,100n)).not.toThrow();
  });
});
