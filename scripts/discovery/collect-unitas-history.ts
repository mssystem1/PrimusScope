import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import { FinanceStrategySchema } from '../../packages/api-schema/src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_PATH = resolve(ROOT, 'data/strategy/unitas-history.json');
const PINS_PATH = resolve(ROOT, 'data/strategy/unitas-history-provenance.json');
const BLAST_RPC_URL = 'https://bsc-mainnet.public.blastapi.io';
const PUBLICNODE_RPC_URL = 'https://bsc-rpc.publicnode.com';
let RPC_URL = BLAST_RPC_URL;
const CHAIN_ID = 56;
const VAULT_PROXY = '0xe9E8573Bb351da16c6EE7DDaC0cBC70b7f9784AE';
const VAULT_IMPLEMENTATION = '0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8';
const STAKED_VAULT = '0x385c279445581a186a4182a5503094ebb652ec71';
const ASSET = '0xea953ea6634d55dac6697c436b1e81a679db5882';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SELECTOR = {
  totalAssets: '0x01e1d114',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
  asset: '0x38d52e0f',
  getUnvestedAmount: '0xe7c2a608',
  convertToAssets: '0x07a2d13a',
  calculateExchangeRate: '0x0ee1265f',
  balanceOf: '0x70a08231',
};
const DEPOSIT_TOPIC = '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7';
const WITHDRAW_TOPIC = '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db';
const SOURCE_VERIFIED_URL = 'https://bscscan.com/address/0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8#code';
const SHARE_SOURCE_URL = 'https://bscscan.com/address/0x385c279445581a186a4182a5503094ebb652ec71#code';
const SAMPLE_DAYS = 60;
let FLOW_DAYS = 30;
const DAY_SECONDS = 86_400;
const BLOCKS_PER_SECOND_GUESS = 2.22;
let MAX_REQUESTS = 550;
const MAX_LOG_REQUESTS = 180;
const MAX_TOTAL_FLOW_REQUESTS = 540;
const MAX_RECEIPTS = 80;
let minRequestSpacingMs = 350;
let logRequestCount = 0;
let lastRequestStart = 0;
let requestQueue: Promise<void> = Promise.resolve();
const MAX_RESPONSE_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 25_000;
const ALIGNMENT_LIMIT_SECONDS = 3_600;
let FLOW_CHUNK_BLOCKS = 50_000;
const MAX_BLOCK_HEADERS_FOR_FLOWS = 240;
const MAX_LOGS_PER_RESPONSE = 10_000;

type RpcResult = Record<string, unknown>;
type Header = { number: bigint; hash: string; timestamp: number };
type SafeFlow = {
  id: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  timestamp: string;
  kind: 'Deposit' | 'Withdraw';
  assetsRaw: string;
  sharesRaw: string;
};
type Dataset = {
  schemaVersion: '1.0.0';
  chainId: 56;
  attribution: 'shared_unitas_strategy';
  proxyAddress: string;
  vaultAddress: string;
  assetAddress: string;
  assetSymbol: 'USDu';
  shareSymbol: 'sUSDu';
  assetDecimals: 18;
  shareDecimals: 18;
  samples: Array<Record<string, unknown>>;
  flows: SafeFlow[];
  flowCoverage: {
    fromBlock: string;
    toBlock: string;
    toBlockHash?: string;
    fromTime: string;
    toTime: string;
    observedAt: string;
    sourceUrl: typeof RPC_URL;
    complete: boolean;
  } | null;
};

let requestCount = 0;
const requestOutcomes: Array<{ method: string; outcome: string }> = [];

class SafeRpcError extends Error {
  readonly code: string;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  readonly limitLike: boolean;
  readonly retryAfterSeconds?: number;
  constructor(code: string, options: { rpcCode?: number; httpStatus?: number; limitLike?: boolean; retryAfterSeconds?: number } = {}) {
    super(code);
    this.name = 'SafeRpcError';
    this.code = code;
    this.rpcCode = options.rpcCode;
    this.httpStatus = options.httpStatus;
    this.limitLike = options.limitLike ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function asHex(value: bigint): string {
  if (value < 0n) throw new Error('negative block number');
  return `0x${value.toString(16)}`;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function parseHeader(value: unknown, expected?: bigint): Header {
  if (!value || typeof value !== 'object') throw new SafeRpcError('INVALID_BLOCK_HEADER');
  const item = value as Record<string, unknown>;
  if (typeof item.number !== 'string' || !/^0x[0-9a-f]+$/i.test(item.number)
      || typeof item.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(item.timestamp)
      || !validHash(item.hash)) throw new SafeRpcError('INVALID_BLOCK_HEADER');
  const number = BigInt(item.number);
  if (expected !== undefined && number !== expected) throw new SafeRpcError('BLOCK_NUMBER_MISMATCH');
  const timestamp = Number(BigInt(item.timestamp));
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new SafeRpcError('INVALID_BLOCK_TIMESTAMP');
  return { number, hash: item.hash.toLowerCase(), timestamp };
}

function safeLimitLike(method: string, message: string, status?: number): boolean {
  if (method !== 'eth_getLogs') return false;
  if (status === 413) return true;
  return /block range|range is too|range too|too many (logs|results)|result window|response size/i.test(message);
}

async function throttleRequest() {
  let release = () => {};
  const before = requestQueue;
  requestQueue = new Promise<void>((resolve) => { release = resolve; });
  await before;
  try {
    const waitMs = Math.max(0, lastRequestStart + minRequestSpacingMs - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestStart = Date.now();
  } finally {
    release();
  }
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (requestCount >= MAX_REQUESTS) throw new SafeRpcError('REQUEST_BUDGET_EXHAUSTED');
  if (method === 'eth_getLogs' && logRequestCount >= MAX_LOG_REQUESTS) throw new SafeRpcError('LOG_REQUEST_BUDGET_EXHAUSTED');
  await throttleRequest();
  requestCount += 1;
  if (method === 'eth_getLogs') logRequestCount += 1;
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestCount, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      requestOutcomes.push({ method, outcome: `HTTP_${response.status}` });
      const retryAfterText = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterText && /^\d{1,6}$/.test(retryAfterText) ? Number(retryAfterText) : undefined;
      throw new SafeRpcError(`HTTP_${response.status}`, {
        httpStatus: response.status,
        limitLike: safeLimitLike(method, '', response.status),
        retryAfterSeconds,
      });
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      requestOutcomes.push({ method, outcome: 'RESPONSE_TOO_LARGE' });
      throw new SafeRpcError('RESPONSE_TOO_LARGE', { limitLike: true });
    }
    let decoded: RpcResult;
    try {
      decoded = JSON.parse(body) as RpcResult;
    } catch {
      requestOutcomes.push({ method, outcome: 'INVALID_JSON' });
      throw new SafeRpcError('INVALID_JSON');
    }
    if (decoded.error && typeof decoded.error === 'object') {
      const error = decoded.error as Record<string, unknown>;
      const code = typeof error.code === 'number' ? error.code : undefined;
      const message = typeof error.message === 'string' ? error.message : '';
      const limitLike = safeLimitLike(method, message);
      requestOutcomes.push({ method, outcome: `RPC_${code ?? 'ERROR'}` });
      throw new SafeRpcError('RPC_ERROR', { rpcCode: code, limitLike });
    }
    requestOutcomes.push({ method, outcome: 'ok' });
    return decoded.result;
  } catch (error) {
    if (error instanceof SafeRpcError) throw error;
    requestOutcomes.push({ method, outcome: 'TRANSPORT_ERROR' });
    throw new SafeRpcError(error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR');
  }
}

async function headerAt(tag: string | bigint): Promise<Header> {
  const raw = await rpc('eth_getBlockByNumber', [typeof tag === 'bigint' ? asHex(tag) : tag, false]);
  return parseHeader(raw, typeof tag === 'bigint' ? tag : undefined);
}

async function readWord(address: string, data: string, block: bigint): Promise<bigint> {
  const result = await rpc('eth_call', [{ to: address, data }, asHex(block)]);
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) throw new SafeRpcError('INVALID_CALL_RESULT');
  return BigInt(result);
}

async function readAddress(address: string, data: string, block: bigint): Promise<string> {
  const word = await readWord(address, data, block);
  return `0x${word.toString(16).padStart(40, '0').slice(-40)}`;
}

async function codeAt(address: string, block: bigint): Promise<string> {
  const result = await rpc('eth_getCode', [address, asHex(block)]);
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new SafeRpcError('INVALID_CODE_RESULT');
  return result.toLowerCase();
}

function implementationFromSlot(slot: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(slot)) throw new SafeRpcError('INVALID_IMPLEMENTATION_SLOT');
  return `0x${slot.slice(-40).toLowerCase()}`;
}

async function assertImplementation(block: bigint): Promise<string> {
  const slot = await rpc('eth_getStorageAt', [VAULT_PROXY, IMPLEMENTATION_SLOT, asHex(block)]);
  if (typeof slot !== 'string') throw new SafeRpcError('INVALID_IMPLEMENTATION_SLOT');
  const actual = implementationFromSlot(slot);
  if (actual !== VAULT_IMPLEMENTATION.toLowerCase()) throw new SafeRpcError('IMPLEMENTATION_MISMATCH');
  return actual;
}

async function blockRate(source: Header, target: Header): Promise<number> {
  const deltaBlock = source.number - target.number;
  const deltaTime = source.timestamp - target.timestamp;
  if (deltaBlock <= 0n || deltaTime <= 0) throw new SafeRpcError('INVALID_BLOCK_RATE_ANCHORS');
  const rate = Number(deltaBlock) / deltaTime;
  if (!Number.isFinite(rate) || rate < 1 || rate > 5) throw new SafeRpcError('INVALID_BLOCK_RATE');
  return rate;
}

async function findTargetHeader(targetTimestamp: number, recent: Header): Promise<Header> {
  let rate = BLOCKS_PER_SECOND_GUESS;
  let guess = recent.number - BigInt(Math.round((recent.timestamp - targetTimestamp) * rate));
  if (guess <= 0n) throw new SafeRpcError('INVALID_TARGET_BLOCK');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = await headerAt(guess);
    const offset = candidate.timestamp - targetTimestamp;
    if (Math.abs(offset) <= ALIGNMENT_LIMIT_SECONDS) return candidate;
    rate = await blockRate(recent, candidate);
    const adjusted = candidate.number + BigInt(Math.round((targetTimestamp - candidate.timestamp) * rate));
    if (adjusted <= 0n || adjusted === guess) throw new SafeRpcError('TARGET_ALIGNMENT_FAILED');
    guess = adjusted;
  }
  throw new SafeRpcError('TARGET_ALIGNMENT_FAILED');
}

function uintData(selector: string, value: bigint): string {
  return `${selector}${value.toString(16).padStart(64, '0')}`;
}

async function metricsAt(block: bigint, observedAt: string, verifyShareConvert = false) {
  const [assets, supply, exchangeRate, unvested, assetBalance] = await Promise.all([
    readWord(STAKED_VAULT, SELECTOR.totalAssets, block),
    readWord(STAKED_VAULT, SELECTOR.totalSupply, block),
    readWord(VAULT_PROXY, uintData(SELECTOR.calculateExchangeRate, 10n ** 18n), block),
    readWord(STAKED_VAULT, SELECTOR.getUnvestedAmount, block),
    readWord(ASSET, uintData(SELECTOR.balanceOf, BigInt(STAKED_VAULT)), block),
  ]);
  if (supply === 0n) throw new SafeRpcError('ZERO_SHARE_SUPPLY');
  const formulaRate = (assets * (10n ** 18n)) / supply;
  if (assetBalance < unvested || assetBalance - unvested !== assets || formulaRate !== exchangeRate) {
    throw new SafeRpcError('EXCHANGE_RATE_FORMULA_MISMATCH');
  }
  if (verifyShareConvert) {
    const converted = await readWord(STAKED_VAULT, uintData(SELECTOR.convertToAssets, 10n ** 18n), block);
    if (converted !== exchangeRate) throw new SafeRpcError('CONVERT_TO_ASSETS_MISMATCH');
  }
  return {
    blockNumber: block.toString(),
    totalAssetsRaw: assets.toString(),
    totalSupplyRaw: supply.toString(),
    exchangeRateRaw: exchangeRate.toString(),
    unvestedRaw: unvested.toString(),
    observedAt,
    sourceUrl: RPC_URL,
  };
}

async function initialValidation(finalized: Header) {
  const [proxyCode, implementationCode, stakedCode, assetCode] = await Promise.all([
    codeAt(VAULT_PROXY, finalized.number),
    codeAt(VAULT_IMPLEMENTATION, finalized.number),
    codeAt(STAKED_VAULT, finalized.number),
    codeAt(ASSET, finalized.number),
  ]);
  if ([proxyCode, implementationCode, stakedCode, assetCode].some((code) => code === '0x')) {
    throw new SafeRpcError('EMPTY_EXPECTED_CODE');
  }
  const implementation = await assertImplementation(finalized.number);
  const [shareDecimals, assetDecimals, shareAsset] = await Promise.all([
    readWord(STAKED_VAULT, SELECTOR.decimals, finalized.number),
    readWord(ASSET, SELECTOR.decimals, finalized.number),
    readAddress(STAKED_VAULT, SELECTOR.asset, finalized.number),
  ]);
  if (shareDecimals !== 18n || assetDecimals !== 18n || shareAsset !== ASSET.toLowerCase()) {
    throw new SafeRpcError('TOKEN_IDENTITY_OR_DECIMALS_MISMATCH');
  }
  return {
    finalizedBlock: finalized.number.toString(),
    finalizedHash: finalized.hash,
    finalizedTimestamp: iso(finalized.timestamp),
    implementationAddress: implementation,
    codePins: {
      proxy: { address: VAULT_PROXY, keccak256: keccak256(proxyCode) },
      implementation: { address: implementation, keccak256: keccak256(implementationCode), sourceUrl: SOURCE_VERIFIED_URL },
      stakedVault: { address: STAKED_VAULT, keccak256: keccak256(stakedCode), sourceUrl: SHARE_SOURCE_URL },
      asset: { address: ASSET, keccak256: keccak256(assetCode) },
    },
    tokenMetadata: { shareDecimals: Number(shareDecimals), assetDecimals: Number(assetDecimals), stakedAsset: shareAsset },
  };
}

function baseDataset(): Dataset {
  return {
    schemaVersion: '1.0.0', chainId: 56, attribution: 'shared_unitas_strategy',
    proxyAddress: VAULT_PROXY, vaultAddress: STAKED_VAULT, assetAddress: ASSET,
    assetSymbol: 'USDu', shareSymbol: 'sUSDu', assetDecimals: 18, shareDecimals: 18,
    samples: [], flows: [], flowCoverage: null,
  };
}

async function writeDataset(dataset: Dataset) {
  const parsed = FinanceStrategySchema.safeParse(dataset);
  if (!parsed.success) throw new Error(`DATASET_SCHEMA_INVALID:${parsed.error.issues.map((x) => x.path.join('.')).join(',')}`);
  await mkdir(dirname(DATA_PATH), { recursive: true });
  const temp = `${DATA_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(temp, DATA_PATH);
}

async function writePins(pins: Record<string, unknown>) {
  await mkdir(dirname(PINS_PATH), { recursive: true });
  const temp = `${PINS_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(temp, PINS_PATH);
}

async function collectSamples() {
  const chain = await rpc('eth_chainId', []);
  if (chain !== '0x38') throw new SafeRpcError('WRONG_CHAIN');
  const finalized = await headerAt('finalized');
  const observedAt = new Date().toISOString();
  const validation = await initialValidation(finalized);
  const dataset = baseDataset();
  const anchors: Array<{ header: Header; sample: Record<string, unknown>; implementation: string }> = [];
  const currentSample = await metricsAt(finalized.number, observedAt, true);
  const currentImplementation = await assertImplementation(finalized.number);
  anchors.push({ header: finalized, sample: currentSample, implementation: currentImplementation });
  const headerPins: Array<Record<string, unknown>> = [{
    blockNumber: finalized.number.toString(), blockHash: finalized.hash,
    timestamp: iso(finalized.timestamp), implementationAddress: currentImplementation,
  }];
  let recentHeader = finalized;
  const unavailability: Array<Record<string, unknown>> = [];
  for (let daysAgo = 1; daysAgo <= SAMPLE_DAYS; daysAgo += 1) {
    const targetTimestamp = finalized.timestamp - daysAgo * DAY_SECONDS;
    let targetHeader: Header;
    try {
      targetHeader = await findTargetHeader(targetTimestamp, recentHeader);
    } catch (error) {
      const code = error instanceof SafeRpcError ? error.code : 'READ_FAILED';
      unavailability.push({ daysAgo, targetTimestamp: iso(targetTimestamp), outcome: code });
      if (code === 'REQUEST_BUDGET_EXHAUSTED') break;
      // Keep a truthful gap; do not invent or forward-fill the missing daily state.
      continue;
    }
    const actualOffset = targetHeader.timestamp - targetTimestamp;
    if (Math.abs(actualOffset) > ALIGNMENT_LIMIT_SECONDS) {
      unavailability.push({ daysAgo, targetTimestamp: iso(targetTimestamp), outcome: 'ALIGNMENT_OUTSIDE_ONE_HOUR' });
      continue;
    }
    let implementation: string;
    let sample: Record<string, unknown>;
    try {
      implementation = await assertImplementation(targetHeader.number);
      sample = await metricsAt(targetHeader.number, observedAt);
    } catch (error) {
      const code = error instanceof SafeRpcError ? error.code : 'READ_FAILED';
      unavailability.push({ daysAgo, blockNumber: targetHeader.number.toString(), targetTimestamp: iso(targetTimestamp), outcome: code });
      if (code === 'REQUEST_BUDGET_EXHAUSTED') break;
      continue;
    }
    const anchor = { header: targetHeader, sample, implementation };
    anchors.push(anchor);
    headerPins.push({
      blockNumber: targetHeader.number.toString(), blockHash: targetHeader.hash,
      timestamp: iso(targetHeader.timestamp), targetTimestamp: iso(targetTimestamp),
      alignmentSeconds: actualOffset, implementationAddress: implementation,
    });
    recentHeader = targetHeader;
  }
  // Explicitly record one current finalized sample and the actual daily samples only.
  dataset.samples = anchors.sort((a, b) => Number(a.header.timestamp - b.header.timestamp)).map((anchor) => ({
    blockNumber: anchor.header.number.toString(), blockHash: anchor.header.hash,
    timestamp: iso(anchor.header.timestamp), observedAt, sourceUrl: RPC_URL,
    totalAssetsRaw: anchor.sample.totalAssetsRaw,
    totalSupplyRaw: anchor.sample.totalSupplyRaw,
    exchangeRateRaw: anchor.sample.exchangeRateRaw,
    unvestedRaw: anchor.sample.unvestedRaw,
  }));
  await writeDataset(dataset);
  const codeHash = (code: string) => createHash('sha256').update(Buffer.from(code.slice(2),'hex')).digest('hex');
  await writePins({
    schemaVersion: '1.0.0', attribution: 'shared_unitas_strategy', chainId: CHAIN_ID,
    sourceUrl: RPC_URL, sourceVerifiedUrl: SOURCE_VERIFIED_URL, shareSourceUrl: SHARE_SOURCE_URL,
    addresses: { proxy: VAULT_PROXY, implementation: VAULT_IMPLEMENTATION, stakedVault: STAKED_VAULT, asset: ASSET },
    validation: {
      ...validation,
      bytecodeSha256: {
        proxy: codeHash((await codeAt(VAULT_PROXY, finalized.number))),
        implementation: codeHash((await codeAt(VAULT_IMPLEMENTATION, finalized.number))),
        stakedVault: codeHash((await codeAt(STAKED_VAULT, finalized.number))),
        asset: codeHash((await codeAt(ASSET, finalized.number))),
      },
      exchangeRateFormula: 'totalAssetsRaw == USDu.balanceOf(sUSDu) - unvestedRaw; floor((totalAssetsRaw * 10^18) / totalSupplyRaw) == exchangeRateRaw.',
      currentConvertToAssetsVerified: true,
      implementationCheckedAtEverySample: true,
    },
    sampleTargets: { dailyDaysAgo: SAMPLE_DAYS, maximumAbsoluteAlignmentSeconds: ALIGNMENT_LIMIT_SECONDS, actualSamples: dataset.samples.length, missing: unavailability },
    head: { number: finalized.number.toString(), hash: finalized.hash, timestamp: iso(finalized.timestamp), tag: 'finalized' },
    requestSummary: { requestCount, maxRequests: MAX_REQUESTS, outcomes: summarizeOutcomes(requestOutcomes) },
    limitations: ['Dataset values describe the shared Unitas strategy, not Primus-attributable balances or flows.', 'No missing daily sample was forward-filled.', 'Source-code ABI and code pins are point-in-time observations; deployment creation metadata is unavailable on the free chain-56 endpoint.'],
  });
  console.log(JSON.stringify({ status: 'samples_saved', path: DATA_PATH, samples: dataset.samples.length, first: dataset.samples[0]?.timestamp, last: dataset.samples.at(-1)?.timestamp, finalizedBlock: finalized.number.toString(), implementation: VAULT_IMPLEMENTATION, requests: requestCount, missingDays: unavailability.length }));
}

function summarizeOutcomes(outcomes: Array<{ method: string; outcome: string }>) {
  const result: Record<string, number> = {};
  for (const item of outcomes) {
    const key = `${item.method}:${item.outcome}`;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function decodeFlow(log: Record<string, unknown>): Omit<SafeFlow, 'timestamp'> {
  const topics = log.topics;
  const data = log.data;
  if (!Array.isArray(topics) || typeof data !== 'string' || !validHash(log.blockHash)
      || !validHash(log.transactionHash) || typeof log.blockNumber !== 'string'
      || typeof log.logIndex !== 'string') throw new SafeRpcError('INVALID_FLOW_LOG');
  const topic0 = String(topics[0]).toLowerCase();
  const kind = topic0 === DEPOSIT_TOPIC ? 'Deposit' : topic0 === WITHDRAW_TOPIC ? 'Withdraw' : null;
  if (!kind || !/^0x[0-9a-f]{128}$/i.test(data)) throw new SafeRpcError('INVALID_FLOW_LOG');
  const assetsRaw = BigInt(`0x${data.slice(2, 66)}`).toString();
  const sharesRaw = BigInt(`0x${data.slice(66, 130)}`).toString();
  const blockNumber = BigInt(log.blockNumber).toString();
  const logIndex = BigInt(log.logIndex).toString();
  const transactionHash = log.transactionHash.toLowerCase();
  return {
    id: `unitas-susdu:56:${transactionHash}:${logIndex}`,
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash,
    logIndex,
    kind,
    assetsRaw,
    sharesRaw,
  };
}

async function getLogsRange(fromBlock: bigint, toBlock: bigint): Promise<{
  logs: RpcResult[];
  complete: boolean;
  lastCompletedBlock: bigint | null;
  gaps: Array<{ fromBlock: string; toBlock: string; outcome: string; retryAfterSeconds?: number }>;
}> {
  const logs: RpcResult[] = [];
  const gaps: Array<{ fromBlock: string; toBlock: string; outcome: string; retryAfterSeconds?: number }> = [];
  let lastCompletedBlock = fromBlock - 1n;
  let stopped = false;
  async function scan(low: bigint, high: bigint): Promise<void> {
    if (stopped) return;
    if (requestCount >= MAX_REQUESTS) {
      stopped = true;
      gaps.push({ fromBlock: low.toString(), toBlock: high.toString(), outcome: 'REQUEST_BUDGET_EXHAUSTED' });
      return;
    }
    if (logRequestCount >= MAX_LOG_REQUESTS) {
      stopped = true;
      gaps.push({ fromBlock: low.toString(), toBlock: high.toString(), outcome: 'LOG_REQUEST_BUDGET_EXHAUSTED' });
      return;
    }
    try {
      const value = await rpc('eth_getLogs', [{
        address: STAKED_VAULT,
        fromBlock: asHex(low),
        toBlock: asHex(high),
        topics: [[DEPOSIT_TOPIC, WITHDRAW_TOPIC]],
      }]);
      if (!Array.isArray(value)) throw new SafeRpcError('INVALID_LOGS_RESULT');
      if (value.length > MAX_LOGS_PER_RESPONSE) {
        if (low < high) {
          const middle = (low + high) / 2n;
          await scan(low, middle);
          if (!stopped) await scan(middle + 1n, high);
          return;
        }
        stopped = true;
        gaps.push({ fromBlock: low.toString(), toBlock: high.toString(), outcome: 'TOO_MANY_LOGS_IN_BLOCK' });
        return;
      }
      logs.push(...value as RpcResult[]);
      if (low === lastCompletedBlock + 1n) lastCompletedBlock = high;
      else if (high > lastCompletedBlock) throw new SafeRpcError('NONCONTIGUOUS_LOG_RANGE');
    } catch (error) {
      const e = error instanceof SafeRpcError ? error : new SafeRpcError('READ_FAILED');
      if (e.httpStatus === 429) {
        stopped = true;
        gaps.push({ fromBlock: low.toString(), toBlock: high.toString(), outcome: 'HTTP_429_RATE_LIMIT', retryAfterSeconds: e.retryAfterSeconds });
        return;
      }
      if (e.limitLike && low < high) {
        const middle = (low + high) / 2n;
        await scan(low, middle);
        if (!stopped) await scan(middle + 1n, high);
        return;
      }
      stopped = true;
      gaps.push({ fromBlock: low.toString(), toBlock: high.toString(), outcome: e.code });
    }
  }
  for (let low = fromBlock; low <= toBlock; low += BigInt(FLOW_CHUNK_BLOCKS)) {
    const high = low + BigInt(FLOW_CHUNK_BLOCKS) - 1n < toBlock ? low + BigInt(FLOW_CHUNK_BLOCKS) - 1n : toBlock;
    await scan(low, high);
    if (stopped) break;
  }
  return { logs, complete: lastCompletedBlock === toBlock && gaps.length === 0, lastCompletedBlock: lastCompletedBlock >= fromBlock ? lastCompletedBlock : null, gaps };
}

async function collectFlowsOnly() {
  RPC_URL = PUBLICNODE_RPC_URL;
  minRequestSpacingMs = 350;
  MAX_REQUESTS = MAX_TOTAL_FLOW_REQUESTS;
  const dayArgument = process.argv.find((argument) => argument.startsWith('--flow-days='));
  if (dayArgument) {
    const parsedDays = Number(dayArgument.slice('--flow-days='.length));
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) throw new SafeRpcError('INVALID_FLOW_DAYS');
    FLOW_DAYS = parsedDays;
    // A 10k-block size has already succeeded for recent and historical PublicNode probes.
    if (FLOW_DAYS <= 7) FLOW_CHUNK_BLOCKS = 10_000;
  }
  const raw = await readFile(DATA_PATH, 'utf8');
  const dataset = FinanceStrategySchema.parse(JSON.parse(raw)) as Dataset;
  if (dataset.samples.length < 1) throw new Error('NO_STOCK_SAMPLES');
  const chain = await rpc('eth_chainId', []);
  if (chain !== '0x38') throw new SafeRpcError('WRONG_CHAIN');
  const latest = await headerAt('finalized');
  const observedAt = new Date().toISOString();
  const targetStartTimestamp = latest.timestamp - FLOW_DAYS * DAY_SECONDS;
  const startSample = [...dataset.samples].sort((a, b) =>
    Math.abs(Date.parse(String(a.timestamp)) / 1000 - targetStartTimestamp)
      - Math.abs(Date.parse(String(b.timestamp)) / 1000 - targetStartTimestamp))[0];
  const start = startSample ?? [...dataset.samples].sort((a, b) => Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)))[0];
  const fromBlock = BigInt(String(start.blockNumber));
  const toBlock = latest.number;
  const fromHeader = await headerAt(fromBlock);
  if (fromHeader.hash !== String(start.blockHash).toLowerCase()) throw new SafeRpcError('SOURCE_BLOCKHASH_MISMATCH');
  const logsResult = await getLogsRange(fromBlock, toBlock);
  const uniqueBlocks = [...new Set(logsResult.logs.map((log) => BigInt(String(log.blockNumber)).toString()))]
    .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const timestamps = new Map<string, string>();
  const headers = new Map<string, Header>([[fromBlock.toString(), fromHeader], [latest.number.toString(), latest]]);
  const scannedToBlock = logsResult.lastCompletedBlock;
  const coveredToHeader = scannedToBlock === null ? null : scannedToBlock === latest.number ? latest : await headerAt(scannedToBlock);
  if (coveredToHeader) headers.set(coveredToHeader.number.toString(), coveredToHeader);
  timestamps.set(fromBlock.toString(), iso(fromHeader.timestamp));
  if (coveredToHeader) timestamps.set(coveredToHeader.number.toString(), iso(coveredToHeader.timestamp));
  let complete = logsResult.lastCompletedBlock !== null;
  const missingTimestampBlocks: string[] = [];
  for (const blockText of uniqueBlocks) {
    if (timestamps.has(blockText)) continue;
    if (requestCount >= MAX_REQUESTS || timestamps.size - 2 >= MAX_BLOCK_HEADERS_FOR_FLOWS) {
      complete = false;
      missingTimestampBlocks.push(blockText);
      continue;
    }
    try {
      const header = await headerAt(BigInt(blockText));
      headers.set(blockText, header);
      timestamps.set(blockText, iso(header.timestamp));
    } catch {
      complete = false;
      missingTimestampBlocks.push(blockText);
    }
  }
  const safeFlows: SafeFlow[] = [];
  for (const log of logsResult.logs) {
    try {
      const flow = decodeFlow(log);
      const blockHeader = headers.get(flow.blockNumber);
      if (!blockHeader || blockHeader.hash !== flow.blockHash) {
        complete = false;
        continue;
      }
      const timestamp = timestamps.get(flow.blockNumber);
      if (!timestamp) {
        complete = false;
        continue;
      }
      safeFlows.push({ ...flow, timestamp });
    } catch {
      complete = false;
    }
  }
  const receiptCheck = { attempted: 0, matchedTransactions: 0, mismatchedTransactions: 0, unavailableTransactions: 0 };
  const transactions = [...new Set(safeFlows.map((flow) => flow.transactionHash))].slice(0, MAX_RECEIPTS);
  const badTransactions = new Set<string>();
  for (const transactionHash of transactions) {
    if (requestCount >= MAX_REQUESTS) break;
    try {
      const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]);
      receiptCheck.attempted += 1;
      if (!receipt || typeof receipt !== 'object') {
        receiptCheck.unavailableTransactions += 1;
        continue;
      }
      const item = receipt as Record<string, unknown>;
      const receiptBlockHash = typeof item.blockHash === 'string' ? item.blockHash.toLowerCase() : '';
      const receiptBlockNumber = typeof item.blockNumber === 'string' ? BigInt(item.blockNumber).toString() : '';
      const receiptLogs = Array.isArray(item.logs) ? item.logs as Array<Record<string, unknown>> : [];
      const flows = safeFlows.filter((flow) => flow.transactionHash === transactionHash);
      const matched = flows.every((flow) => receiptLogs.some((log) => {
        const topics = Array.isArray(log.topics) ? log.topics : [];
        const topic0 = typeof topics[0] === 'string' ? topics[0].toLowerCase() : '';
        return String(log.address ?? '').toLowerCase() === STAKED_VAULT.toLowerCase()
          && String(log.logIndex ?? '').toLowerCase() === asHex(BigInt(flow.logIndex)).toLowerCase()
          && String(log.blockHash ?? '').toLowerCase() === flow.blockHash
          && topic0 === (flow.kind === 'Deposit' ? DEPOSIT_TOPIC : WITHDRAW_TOPIC);
      }));
      if (receiptBlockHash === flows[0]?.blockHash && receiptBlockNumber === flows[0]?.blockNumber && matched) {
        receiptCheck.matchedTransactions += 1;
      } else {
        receiptCheck.mismatchedTransactions += 1;
        badTransactions.add(transactionHash);
        complete = false;
      }
    } catch {
      receiptCheck.unavailableTransactions += 1;
    }
  }
  const finalFlows = safeFlows.filter((flow) => !badTransactions.has(flow.transactionHash));
  finalFlows.sort((a, b) => BigInt(a.blockNumber) === BigInt(b.blockNumber)
    ? (BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : 1)
    : (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1));
  dataset.flows = finalFlows;
  if (coveredToHeader) {
    dataset.flowCoverage = {
      fromBlock: fromBlock.toString(), toBlock: coveredToHeader.number.toString(),toBlockHash:coveredToHeader.hash,
      fromTime: iso(fromHeader.timestamp), toTime: iso(coveredToHeader.timestamp), observedAt,
      sourceUrl: PUBLICNODE_RPC_URL, complete: complete && missingTimestampBlocks.length === 0 && badTransactions.size === 0,
    };
  } else {
    dataset.flowCoverage = null;
  }
  await writeDataset(dataset);
  const flowReport = {
    schemaVersion: '1.0.0', sourceUrl: PUBLICNODE_RPC_URL, stakedVault: STAKED_VAULT,
    requestedRange: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), fromTime: iso(fromHeader.timestamp), toTime: iso(latest.timestamp) },
    requestedDays: FLOW_DAYS,
    coveredRange: coveredToHeader ? { fromBlock: fromBlock.toString(), toBlock: coveredToHeader.number.toString(), fromTime: iso(fromHeader.timestamp), toTime: iso(coveredToHeader.timestamp) } : null,
    coverageCompleteWithinCoveredRange: Boolean(coveredToHeader) && complete && missingTimestampBlocks.length === 0,
    partialHistory: FLOW_DAYS < 30 || !logsResult.complete,
    flowCount: finalFlows.length,
    eventCounts: finalFlows.reduce((counts, flow) => ({ ...counts, [flow.kind]: (counts[flow.kind] ?? 0) + 1 }), {} as Record<string, number>),
    logRequests: logRequestCount, maxLogRequests: MAX_LOG_REQUESTS,
    splitGaps: logsResult.gaps, missingTimestampBlocks, receiptCheck,
    privacyProjection: 'Deposit/Withdraw transaction identity, timestamp, block hash, log index, assetsRaw and sharesRaw only; sender, owner and receiver topics omitted.',
    attribution: 'shared_unitas_strategy; these are not Primus-specific flows.',
    requestSummary: { requestCount, maxRequests: MAX_REQUESTS, outcomes: summarizeOutcomes(requestOutcomes) },
  };
  const previousPins = JSON.parse(await readFile(PINS_PATH, 'utf8')) as Record<string, unknown>;
  const oldFlow = previousPins.flowCollection;
  const attemptHistory = Array.isArray((oldFlow as Record<string, unknown> | undefined)?.attemptHistory)
    ? (oldFlow as Record<string, unknown>).attemptHistory as unknown[] : [];
  const priorFlowSource = oldFlow && typeof (oldFlow as Record<string, unknown>).sourceUrl === 'string'
    ? String((oldFlow as Record<string, unknown>).sourceUrl) : 'unknown source';
  const priorAttempt = oldFlow ? { attempt: `prior flow scan via ${priorFlowSource}`, requestedRange: (oldFlow as Record<string, unknown>).requestedRange, splitGaps: (oldFlow as Record<string, unknown>).splitGaps, requestSummary: (oldFlow as Record<string, unknown>).requestSummary } : null;
  const enrichedFlowReport = { ...flowReport, attemptHistory: [...attemptHistory, ...(priorAttempt ? [priorAttempt] : [])] };
  await writePins({ ...previousPins, flowCollection: enrichedFlowReport });
  console.log(JSON.stringify({ status: 'flows_saved', path: DATA_PATH, flowCount: finalFlows.length, coverageCompleteWithinCoveredRange: Boolean(coveredToHeader) && complete, partialHistory: FLOW_DAYS < 30 || !logsResult.complete, coveredFrom: fromBlock.toString(), coveredTo: coveredToHeader?.number.toString() ?? null, requestedTo: latest.number.toString(), logRequests: logRequestCount, requests: requestCount, gaps: logsResult.gaps.length, missingTimestampBlocks: missingTimestampBlocks.length, receiptsMatched: receiptCheck.matchedTransactions }));
}

async function main() {
  if (process.argv.includes('--flows-only')) {
    await collectFlowsOnly();
    return;
  }
  await collectSamples();
}

main().catch((error: unknown) => {
  const code = error instanceof SafeRpcError ? error.code : error instanceof Error && error.message.startsWith('DATASET_SCHEMA_INVALID') ? error.message : 'HARVEST_FAILED';
  console.error(JSON.stringify({ status: 'blocked', code, requestCount, outcomes: summarizeOutcomes(requestOutcomes) }));
  process.exitCode = 1;
});
