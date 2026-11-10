import { createHash } from 'node:crypto';
import { decodeEventLog, getEventSelector, toFunctionSelector, type Hex } from 'viem';
import { FinanceStrategySchema, type FinanceStrategy, type StrategySample } from '@primusscope/api-schema';
import baselineData from '../../../data/strategy/unitas-history.json';
import provenance from '../../../data/strategy/unitas-history-provenance.json';
import { FetchRpc } from './fetch-rpc';
import { WorkerError, bytes, hash, header, hexQuantity, type Header } from './registry';
import type { Rpc } from './rpc';

const BLAST = 'https://bsc-mainnet.public.blastapi.io';
const PUBLICNODE = 'https://bsc-rpc.publicnode.com';
const PROXY = '0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae';
const IMPLEMENTATION = '0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8';
const VAULT = '0x385c279445581a186a4182a5503094ebb652ec71';
const ASSET = '0xea953ea6634d55dac6697c436b1e81a679db5882';
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const DEPOSIT_ABI = [{ type: 'event', name: 'Deposit', inputs: [
  { name: 'sender', type: 'address', indexed: true }, { name: 'owner', type: 'address', indexed: true },
  { name: 'assets', type: 'uint256', indexed: false }, { name: 'shares', type: 'uint256', indexed: false },
] }] as const;
const WITHDRAW_ABI = [{ type: 'event', name: 'Withdraw', inputs: [
  { name: 'sender', type: 'address', indexed: true }, { name: 'receiver', type: 'address', indexed: true },
  { name: 'owner', type: 'address', indexed: true }, { name: 'assets', type: 'uint256', indexed: false },
  { name: 'shares', type: 'uint256', indexed: false },
] }] as const;
const DEPOSIT = getEventSelector(DEPOSIT_ABI[0]);
const WITHDRAW = getEventSelector(WITHDRAW_ABI[0]);
const ERC4626_TOPICS = [DEPOSIT, WITHDRAW];
const sha256 = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const qty = (n: bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const abs = (n: bigint) => n < 0n ? -n : n;
type StrategyFlow = FinanceStrategy['flows'][number];
function addressWord(value: unknown): string {
  const raw = bytes(value, 32);
  if (raw.length !== 66 || !/^0x0{24}[0-9a-f]{40}$/.test(raw)) throw new WorkerError('STRATEGY_CALL_INVALID');
  return `0x${raw.slice(-40)}`;
}
function uintWord(value: unknown): bigint {
  const raw = bytes(value, 32);
  if (raw.length !== 66) throw new WorkerError('STRATEGY_CALL_INVALID');
  return BigInt(raw);
}
async function fixedCall(rpc: Rpc, to: string, signature: string, block: string, args = ''): Promise<unknown> {
  return bytes(await rpc.call('eth_call', [{ to, data: `${toFunctionSelector(signature)}${args}` }, block]), 32_000);
}
function runtimeHash(value: unknown) {
  const code = bytes(value);
  if (code === '0x') throw new WorkerError('STRATEGY_CODE_MISSING');
  return sha256(code);
}
function baseline(): FinanceStrategy { return FinanceStrategySchema.parse(baselineData); }
function asCode(error: unknown) {
  const code = error instanceof WorkerError ? error.code : 'FLOW_COLLECTION_FAILED';
  return code.startsWith('FLOW_') ? code : `FLOW_${code}`;
}

async function stockSample(rpc: Rpc, now: () => Date): Promise<StrategySample> {
  if (hexQuantity(await rpc.call('eth_chainId', [])) !== 56n) throw new WorkerError('STRATEGY_WRONG_CHAIN');
  const initial = header(await rpc.call('eth_getBlockByNumber', ['finalized', false]));
  const block = qty(initial.number);
  const proxyCode = await rpc.call('eth_getCode', [PROXY, block]);
  const implementationCode = await rpc.call('eth_getCode', [IMPLEMENTATION, block]);
  const stakedCode = await rpc.call('eth_getCode', [VAULT, block]);
  const assetCode = await rpc.call('eth_getCode', [ASSET, block]);
  const slot = await rpc.call('eth_getStorageAt', [PROXY, SLOT, block]);
  const staked = await fixedCall(rpc, PROXY, 'staked()', block);
  const asset = await fixedCall(rpc, PROXY, 'usdu()', block);
  const assetDecimals = await fixedCall(rpc, ASSET, 'decimals()', block);
  const shareDecimals = await fixedCall(rpc, VAULT, 'decimals()', block);
  const totalAssets = await fixedCall(rpc, VAULT, 'totalAssets()', block);
  const totalSupply = await fixedCall(rpc, VAULT, 'totalSupply()', block);
  const unvested = await fixedCall(rpc, VAULT, 'getUnvestedAmount()', block);
  const convert = await fixedCall(rpc, VAULT, 'convertToAssets(uint256)', block, word(10n ** 18n));
  const exchange = await fixedCall(rpc, PROXY, 'calculateExchangeRate(uint256)', block, word(10n ** 18n));
  const balance = await fixedCall(rpc, ASSET, 'balanceOf(address)', block, word(BigInt(VAULT)));
  const pins = (provenance as typeof provenance & { validation: { bytecodeSha256: Record<string, string> } }).validation.bytecodeSha256;
  if (runtimeHash(proxyCode) !== pins.proxy || runtimeHash(implementationCode) !== pins.implementation
      || runtimeHash(stakedCode) !== pins.stakedVault || runtimeHash(assetCode) !== pins.asset) throw new WorkerError('STRATEGY_CODE_CHANGED');
  const slotValue = bytes(slot, 32);
  if (slotValue.length !== 66 || !/^0x0{24}/.test(slotValue) || `0x${slotValue.slice(-40)}` !== IMPLEMENTATION) throw new WorkerError('STRATEGY_IMPLEMENTATION_CHANGED');
  if (addressWord(staked) !== VAULT || addressWord(asset) !== ASSET || uintWord(assetDecimals) !== 18n || uintWord(shareDecimals) !== 18n) {
    throw new WorkerError('STRATEGY_METADATA_CHANGED');
  }
  const assets = uintWord(totalAssets), supply = uintWord(totalSupply), vested = uintWord(unvested), rate = uintWord(exchange);
  const conversion = uintWord(convert), held = uintWord(balance);
  if (held < vested || abs(held - vested - assets) > 2n || supply === 0n
      || abs((assets * 10n ** 18n / supply) - rate) > 2n
      || abs(conversion - rate) > 2n) throw new WorkerError('STRATEGY_ACCOUNTING_MISMATCH');
  const confirmed = header(await rpc.call('eth_getBlockByNumber', [block, false]), initial.number);
  if (confirmed.hash !== initial.hash) throw new WorkerError('STRATEGY_BLOCK_CHANGED');
  return { blockNumber: String(initial.number), blockHash: initial.hash, timestamp: initial.time,
    observedAt: now().toISOString(), sourceUrl: BLAST, totalAssetsRaw: String(assets), totalSupplyRaw: String(supply),
    exchangeRateRaw: String(rate), unvestedRaw: String(vested) };
}

export function projectStrategyFlowLog(value: unknown, block: bigint): Omit<StrategyFlow, 'timestamp'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkerError('FLOW_INVALID_LOG');
  const raw = value as Record<string, unknown>;
  if (typeof raw.address !== 'string' || raw.address.toLowerCase() !== VAULT || raw.removed !== false
      || !Array.isArray(raw.topics) || raw.topics.length < 1) throw new WorkerError('FLOW_INVALID_LOG');
  const topic0 = hash(raw.topics[0]);
  const abi = topic0 === DEPOSIT ? DEPOSIT_ABI : topic0 === WITHDRAW ? WITHDRAW_ABI : null;
  if (!abi) throw new WorkerError('FLOW_UNKNOWN_EVENT');
  if(raw.topics.length!==(topic0===DEPOSIT?3:4)||bytes(raw.data,128).length!==130)throw new WorkerError('FLOW_INVALID_LOG');
  let decoded;
  try { decoded = decodeEventLog({ abi, data: bytes(raw.data, 128), topics: raw.topics.map(t => hash(t)) as [Hex, ...Hex[]], strict: true }); }
  catch { throw new WorkerError('FLOW_DECODE_FAILED'); }
  const event = decoded.args as { assets: bigint; shares: bigint };
  const blockNumber = hexQuantity(raw.blockNumber), logIndex = hexQuantity(raw.logIndex);
  if (blockNumber !== block || typeof event.assets !== 'bigint' || typeof event.shares !== 'bigint') throw new WorkerError('FLOW_INVALID_LOG');
  const blockHash = hash(raw.blockHash), transactionHash = hash(raw.transactionHash);
  return { id: `56:${VAULT}:${transactionHash}:${logIndex}`, blockNumber: String(blockNumber), blockHash,
    transactionHash, logIndex: String(logIndex), kind: topic0 === DEPOSIT ? 'Deposit' : 'Withdraw',
    assetsRaw: String(event.assets), sharesRaw: String(event.shares) };
}

export function mergeStrategySamples(previous: StrategySample[], latest: StrategySample[]): StrategySample[] {
  const newest = latest.reduce((a, b) => Date.parse(a.timestamp) >= Date.parse(b.timestamp) ? a : b);
  const cutoff = Date.parse(newest.timestamp) - 90 * 86400_000;
  const byHour = new Map<string, StrategySample>();
  for (const sample of [...previous, ...latest].filter(s => Date.parse(s.timestamp) >= cutoff && Date.parse(s.timestamp) <= Date.parse(newest.timestamp))) {
    const hour = new Date(Math.floor(Date.parse(sample.timestamp) / 3600_000) * 3600_000).toISOString();
    byHour.set(hour, sample);
  }
  return [...byHour.values()].sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : 0).slice(-5000);
}

export function strategyFlowStart(previous: FinanceStrategy, targetBlock: bigint): bigint {
  return previous.flowCoverage?.complete ? BigInt(previous.flowCoverage.toBlock) + 1n : targetBlock;
}

export function reconcileStrategyFlowShares(logs:Pick<StrategyFlow,'kind'|'sharesRaw'>[],before:bigint,after:bigint){
  const net=logs.reduce((sum,flow)=>sum+(flow.kind==='Deposit'?BigInt(flow.sharesRaw):-BigInt(flow.sharesRaw)),0n);
  if(net!==after-before)throw new WorkerError('FLOW_SUPPLY_RECONCILIATION_FAILED');
}
export function mergeStrategyLogReads(groups:unknown[],from:bigint,to:bigint){
  const unique=new Map<string,Record<string,unknown>>();
  for(const group of groups){
    if(!Array.isArray(group))throw new WorkerError('FLOW_INVALID_LOG');
    for(const raw of group){
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new WorkerError('FLOW_INVALID_LOG');
      const item=raw as Record<string,unknown>;
      if(typeof item.address!=='string'||item.address.toLowerCase()!==VAULT||!Array.isArray(item.topics)||!item.topics.length)throw new WorkerError('FLOW_INVALID_LOG');
      const block=hexQuantity(item.blockNumber);if(block<from||block>to)throw new WorkerError('FLOW_LOG_OUTSIDE_RANGE');
      const topic=hash(item.topics[0]);if(!ERC4626_TOPICS.includes(topic))continue;
      const projected=projectStrategyFlowLog(item,block),existing=unique.get(projected.id);
      if(existing){
        const old=projectStrategyFlowLog(existing,block);
        if(JSON.stringify(old)!==JSON.stringify(projected))throw new WorkerError('FLOW_CONFLICTING_LOG_READS');
      }else unique.set(projected.id,item);
    }
  }
  return [...unique.values()].sort((a,b)=>{const an=hexQuantity(a.blockNumber),bn=hexQuantity(b.blockNumber);return an<bn?-1:an>bn?1:hexQuantity(a.logIndex)<hexQuantity(b.logIndex)?-1:1;});
}

async function collectFlows(rpc: Rpc, stock: StrategySample, previous: FinanceStrategy, now: () => Date, accountingRpc:Rpc): Promise<Pick<FinanceStrategy, 'flows' | 'flowCoverage'>> {
  if (hexQuantity(await rpc.call('eth_chainId', [])) !== 56n) throw new WorkerError('FLOW_WRONG_CHAIN');
  const target = BigInt(stock.blockNumber);
  const old = previous.flowCoverage?.complete ? previous.flowCoverage : null;
  const from = strategyFlowStart(previous, target);
  if (from > target) return { flows: previous.flows, flowCoverage: previous.flowCoverage };
  let to = from + 9_999n < target ? from + 9_999n : target;
  const publicTarget = header(await rpc.call('eth_getBlockByNumber', [qty(target), false]), target);
  if (publicTarget.hash !== stock.blockHash) throw new WorkerError('FLOW_TARGET_HASH_MISMATCH');
  let previousBoundary:Header|null=null;
  if (old) {
    const boundary = header(await rpc.call('eth_getBlockByNumber', [qty(BigInt(old.toBlock)), false]), BigInt(old.toBlock));
    previousBoundary=boundary;
    if (boundary.time !== old.toTime || (old.toBlockHash&&boundary.hash!==old.toBlockHash)
      || previous.flows.some(flow => flow.blockNumber === old.toBlock && flow.blockHash !== boundary.hash)) {
      throw new WorkerError('FLOW_BOUNDARY_HASH_MISMATCH');
    }
  }
  let rawLogs: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    const topicRead=await rpc.call('eth_getLogs', [{ address: VAULT, fromBlock: qty(from), toBlock: qty(to), topics: [ERC4626_TOPICS] }]);
    const addressRead=await rpc.call('eth_getLogs', [{ address: VAULT, fromBlock: qty(from), toBlock: qty(to) }]);
    rawLogs=mergeStrategyLogReads([topicRead,addressRead],from,to);
    if (!Array.isArray(rawLogs)) throw new WorkerError('FLOW_INVALID_LOG');
    if (rawLogs.length <= 60) break;
    const boundaryLog = rawLogs[60] as Record<string, unknown>;
    const splitAt = hexQuantity(boundaryLog.blockNumber);
    if (splitAt <= from || splitAt > to) throw new WorkerError('FLOW_EVENT_LIMIT');
    to = splitAt - 1n;
  }
  if (!Array.isArray(rawLogs) || rawLogs.length > 60) throw new WorkerError('FLOW_EVENT_LIMIT');
  const ending = header(await rpc.call('eth_getBlockByNumber', [qty(to), false]), to);
  const rawById = new Map<string, Record<string, unknown>>();
  const logs = rawLogs.map(raw => {
    const item = raw as Record<string, unknown>;
    const parsed = projectStrategyFlowLog(raw, hexQuantity(item.blockNumber));
    if (BigInt(parsed.blockNumber) < from || BigInt(parsed.blockNumber) > to) throw new WorkerError('FLOW_LOG_OUTSIDE_RANGE');
    if (rawById.has(parsed.id)) throw new WorkerError('FLOW_DUPLICATE_LOG');
    rawById.set(parsed.id, item);
    return parsed;
  });
  // A successful log response may still omit events. Check share conservation
  // before spending the remaining budget on receipt validation or advancing coverage.
  if(old&&previousBoundary){
    const beforeSample=previous.samples.find(sample=>sample.blockNumber===old.toBlock);
    let before:bigint;
    if(beforeSample){
      if(beforeSample.blockHash!==previousBoundary.hash)throw new WorkerError('FLOW_ACCOUNTING_HASH_MISMATCH');
      before=BigInt(beforeSample.totalSupplyRaw);
    }else{
      const beforeHeader=header(await accountingRpc.call('eth_getBlockByNumber',[qty(BigInt(old.toBlock)),false]),BigInt(old.toBlock));
      if(beforeHeader.hash!==previousBoundary.hash)throw new WorkerError('FLOW_ACCOUNTING_HASH_MISMATCH');
      before=uintWord(await fixedCall(accountingRpc,VAULT,'totalSupply()',qty(BigInt(old.toBlock))));
    }
    let after=BigInt(stock.totalSupplyRaw);
    if(to!==target){
      const afterHeader=header(await accountingRpc.call('eth_getBlockByNumber',[qty(to),false]),to);
      if(afterHeader.hash!==ending.hash)throw new WorkerError('FLOW_ACCOUNTING_HASH_MISMATCH');
      after=uintWord(await fixedCall(accountingRpc,VAULT,'totalSupply()',qty(to)));
    }
    reconcileStrategyFlowShares(logs,before,after);
  }
  const positions = new Set<string>();
  for (const event of logs) {
    const position = `${event.blockHash}:${event.logIndex}`;
    if (positions.has(position)) throw new WorkerError('FLOW_DUPLICATE_POSITION');
    positions.add(position);
  }
  const blockCache = new Map<string, Header>(), receiptCache = new Map<string, Record<string, unknown>>();
  for (const event of logs) {
    let blockHeader = blockCache.get(event.blockNumber);
    if (!blockHeader) {
      blockHeader = header(await rpc.call('eth_getBlockByNumber', [qty(BigInt(event.blockNumber)), false]), BigInt(event.blockNumber));
      blockCache.set(event.blockNumber, blockHeader);
    }
    if (blockHeader.hash !== event.blockHash) throw new WorkerError('FLOW_BLOCK_HASH_MISMATCH');
    let receipt = receiptCache.get(event.transactionHash);
    if (!receipt) {
      const value = await rpc.call('eth_getTransactionReceipt', [event.transactionHash]);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkerError('FLOW_RECEIPT_MISMATCH');
      receipt = value as Record<string, unknown>; receiptCache.set(event.transactionHash, receipt);
    }
    const matching = Array.isArray(receipt.logs) ? receipt.logs.filter((v: unknown) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const l = v as Record<string, unknown>;
      return typeof l.address === 'string' && l.address.toLowerCase() === VAULT && hexQuantity(l.logIndex) === BigInt(event.logIndex);
    }) : [];
    if (matching.length !== 1) throw new WorkerError('FLOW_RECEIPT_MISMATCH');
    const log = matching[0] as Record<string, unknown>;
    const sourceLog = rawById.get(event.id)!;
    if (hash(receipt.transactionHash) !== event.transactionHash || hash(receipt.blockHash) !== event.blockHash
        || hexQuantity(receipt.blockNumber) !== BigInt(event.blockNumber) || hexQuantity(receipt.status) !== 1n || log.removed !== false
        || hash(log.blockHash) !== event.blockHash || hash(log.transactionHash) !== event.transactionHash
        || hexQuantity(log.blockNumber) !== BigInt(event.blockNumber) || bytes(log.data, 128) !== bytes(sourceLog.data, 128)
        || !Array.isArray(log.topics) || JSON.stringify(log.topics.map(hash)) !== JSON.stringify((sourceLog.topics as unknown[]).map(hash))) {
      throw new WorkerError('FLOW_RECEIPT_MISMATCH');
    }
  }
  const endingAfter = header(await rpc.call('eth_getBlockByNumber', [qty(to), false]), to);
  if (endingAfter.hash !== ending.hash) throw new WorkerError('FLOW_END_BLOCK_CHANGED');
  const timed = logs.map(event => ({ ...event, timestamp: blockCache.get(event.blockNumber)!.time }));
  const startHeader = old ? null : from === to ? ending : blockCache.get(String(from)) ?? header(await rpc.call('eth_getBlockByNumber', [qty(from), false]), from);
  const flowsById = new Map(previous.flows.map(flow => [flow.id, flow]));
  for (const flow of timed) {
    const existing = flowsById.get(flow.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(flow)) throw new WorkerError('FLOW_CONFLICTING_ID');
    flowsById.set(flow.id, flow);
  }
  if (flowsById.size > 20_000) throw new WorkerError('FLOW_CAPACITY');
  const flows = [...flowsById.values()].sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : BigInt(a.logIndex) > BigInt(b.logIndex) ? 1 : a.id.localeCompare(b.id));
  return { flows, flowCoverage: { fromBlock: old?.fromBlock ?? String(from), toBlock: String(to), toBlockHash:ending.hash,
    fromTime: old?.fromTime ?? startHeader!.time, toTime: ending.time, observedAt: now().toISOString(), sourceUrl: PUBLICNODE,
    sourceUrls:[...new Set<NonNullable<FinanceStrategy['flowCoverage']>['sourceUrl']>([...(old?.sourceUrls??(old?[old.sourceUrl]:[])),PUBLICNODE])], complete: true } };
}

export async function collectPublicStrategy(previous?: FinanceStrategy, rpcOverrides: { stockRpc?: Rpc; flowRpc?: Rpc; now?: () => Date } = {}): Promise<{ strategy: FinanceStrategy; flowIssueCode?: string }> {
  const prior = FinanceStrategySchema.parse(previous ?? baseline());
  const now = rpcOverrides.now ?? (() => new Date());
  const stockRpc = rpcOverrides.stockRpc ?? new FetchRpc(BLAST, { maxRequests: 30, maxSeconds: 45, timeoutSeconds: 5, maxResponseBytes: 1_000_000, minIntervalMs: 350 });
  const flowRpc = rpcOverrides.flowRpc ?? new FetchRpc(PUBLICNODE, { maxRequests: 150, maxSeconds: 60, timeoutSeconds: 5, maxResponseBytes: 2_000_000, minIntervalMs: 350 });
  const sample = await stockSample(stockRpc, now);
  const previousHead=prior.samples.reduce((latest,current)=>BigInt(current.blockNumber)>BigInt(latest.blockNumber)?current:latest,prior.samples[0]??sample);
  if(BigInt(sample.blockNumber)<BigInt(previousHead.blockNumber)||Date.parse(sample.timestamp)<Date.parse(previousHead.timestamp))throw new WorkerError('STRATEGY_HEAD_BEHIND');
  if(sample.blockNumber===previousHead.blockNumber&&sample.blockHash!==previousHead.blockHash)throw new WorkerError('STRATEGY_BLOCK_CHANGED');
  const common = { ...prior, samples: mergeStrategySamples(prior.samples, [sample]) };
  try {
    const flow = await collectFlows(flowRpc, sample, prior, now, stockRpc);
    return { strategy: FinanceStrategySchema.parse({ ...common, ...flow }) };
  } catch (error) {
    return { strategy: FinanceStrategySchema.parse(common), flowIssueCode: asCode(error) };
  }
}
