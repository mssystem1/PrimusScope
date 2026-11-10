/**
 * Explicitly project retained, real discovery observations into a serving file.
 * No provider requests, interpolation, credentials or private fields are used.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObservationSetSchema, type ObservationSet } from '@primusscope/api-schema';

type Row = Record<string, unknown>;

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SOURCE_OBJECT');
  return value as Row;
}

function list(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error('INVALID_SOURCE_ARRAY');
  return value.map(object);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_SOURCE_STRING');
  return value;
}

function address(value: unknown): string {
  const result = text(value).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) throw new Error('INVALID_SOURCE_ADDRESS');
  return result;
}

function hash(value: unknown): string {
  const result = text(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) throw new Error('INVALID_SOURCE_HASH');
  return result;
}

function integer(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_SOURCE_INTEGER');
    return String(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new Error('INVALID_SOURCE_INTEGER');
  }
  return value;
}

function unixTime(value: unknown): string {
  const seconds = BigInt(integer(value));
  if (seconds > 8_640_000_000_000n) throw new Error('INVALID_SOURCE_TIMESTAMP');
  return new Date(Number(seconds) * 1000).toISOString();
}

function instant(value: unknown): string {
  const milliseconds = Date.parse(text(value));
  if (!Number.isFinite(milliseconds)) throw new Error('INVALID_SOURCE_TIMESTAMP');
  return new Date(milliseconds).toISOString();
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rootDirectory(start = process.cwd()): string {
  let path = resolve(start);
  for (;;) {
    const manifest = join(path, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'primusscope') return path;
    const parent = dirname(path);
    if (parent === path) throw new Error('REPOSITORY_ROOT_NOT_FOUND');
    path = parent;
  }
}

export function buildObservationSet(root: string, generatedAt = new Date()): ObservationSet {
  const read = (path: string) => object(JSON.parse(readFileSync(join(root, path), 'utf8')));
  const finance = read('docs/discovery/bsc-rpc-observation.json');
  const native = read('docs/discovery/bsc-native-observation.json');
  const window = read('docs/discovery/bsc-window-observation.json');
  const network = read('docs/discovery/network-free-rpc-observation.json');
  const registry = read('scripts/discovery/sources/bsc-finance-source.json');
  const financeRange = object(finance.requestedRange);
  const nativeRange = object(native.range);
  const windowRange = object(window.range);
  const networkTrial = list(network.trials)[0];
  if (!networkTrial) throw new Error('NETWORK_SCOPE_MISSING');
  if (finance.status !== 'bounded_batch_sample_observed' || native.status !== 'bounded_batch_sample_reconciled'
    || network.status !== 'bounded_network_sample_observed'
    || finance.observedChainId !== 56 || network.observedChainId !== 8453) {
    throw new Error('SOURCE_NOT_VALIDATED');
  }
  for (const key of ['fromBlock', 'toBlock']) {
    if (integer(financeRange[key]) !== integer(nativeRange[key])
      || integer(financeRange[key]) !== integer(windowRange[key])) throw new Error('FINANCE_SCOPE_MISMATCH');
  }
  const networkHeader = object(network.providerReportedFinalized);
  if (integer(networkTrial.toBlock) !== integer(networkHeader.number)) throw new Error('NETWORK_WATERMARK_MISMATCH');
  const contractChecks = list(finance.contractChecks);
  const contracts = Object.entries(object(registry.routes)).flatMap(([routeKey, value]) => {
    const route = object(value);
    return (['deposit', 'redeem'] as const).map(role => {
      const contractAddress = address(route[role === 'deposit' ? 'depositAggregator' : 'redeemAggregator']);
      const check = contractChecks.find(item => address(item.address) === contractAddress);
      if (!check || check.implementationMatchesSource !== true) throw new Error('CONTRACT_SOURCE_MISMATCH');
      return {
        id: 'bsc-' + routeKey + '-' + role,
        routeId: text(route.id), role, address: contractAddress,
        implementationAddress: address(check.observedImplementation), abiSha256: text(check.abiSha256),
      };
    });
  });

  const identity = (event: Row) => [
    address(event.contractAddress), hash(event.transactionHash), integer(event.logIndex),
    integer(event.blockNumber), hash(event.blockHash),
  ].join(':');
  const scannedEvents = list(object(finance.scan).events);
  const nativeEvents = list(native.events);
  const scanIds = new Set(scannedEvents.map(identity));
  const scanById = new Map(scannedEvents.map(event => [identity(event), event]));
  if (scanIds.size !== scannedEvents.length || nativeEvents.length !== scanIds.size
    || nativeEvents.some(event => {
      const scanned = scanById.get(identity(event));
      return !scanned || event.receiptIdentityMatch !== true
        || scanned.event !== event.event || integer(scanned.batchId) !== integer(event.batchId);
    })) {
    throw new Error('FINANCE_RECEIPT_EVIDENCE_MISMATCH');
  }
  const timeByIdentity = new Map<string, string>();
  const latencySamples = list(native.latencySamples).map(sample => {
    const contractAddress = address(sample.contractAddress);
    const batchId = integer(sample.batchId);
    const dispatchedAt = unixTime(sample.dispatchTimestampUnix);
    const finalizedAt = unixTime(sample.finalizedTimestampUnix);
    for (const [kind, time] of [['AggregateDispatched', dispatchedAt], ['AggregateFinalized', finalizedAt]]) {
      const matches = nativeEvents.filter(event => address(event.contractAddress) === contractAddress
        && integer(event.batchId) === batchId && event.event === kind);
      if (matches.length !== 1) throw new Error('AMBIGUOUS_LATENCY_EVIDENCE');
      timeByIdentity.set(identity(matches[0]!), time!);
    }
    return { contractAddress, batchId, seconds: integer(sample.dispatchToFinalizedSeconds), dispatchedAt, finalizedAt };
  });
  const financeEvents = nativeEvents.map(event => {
    const contractAddress = address(event.contractAddress);
    const transactionHash = hash(event.transactionHash);
    const logIndex = integer(event.logIndex);
    return {
      id: ['56', contractAddress, transactionHash, logIndex].join(':'),
      contractAddress, transactionHash, logIndex,
      blockNumber: integer(event.blockNumber), blockHash: hash(event.blockHash),
      timestamp: timeByIdentity.get(identity(event)) ?? null, sourceId: 'bsc-publicnode',
      kind: text(event.event), batchId: integer(event.batchId),
    };
  });
  const networkEvents = list(network.events).map(event => {
    const contractAddress = address(event.address);
    const transactionHash = hash(event.transactionHash);
    const logIndex = integer(event.logIndex);
    const kind = text(event.event);
    return {
      id: ['8453', contractAddress, transactionHash, logIndex].join(':'),
      contractAddress, transactionHash, logIndex,
      blockNumber: integer(event.blockNumber), blockHash: hash(event.blockHash),
      timestamp: null, sourceId: 'base-publicnode', kind,
      taskId: kind === 'WithdrawBalance' ? null : hash(event.taskId),
    };
  });
  if (integer(networkTrial.recognizedEventCount) !== String(networkEvents.length)) {
    throw new Error('NETWORK_EVENT_COUNT_MISMATCH');
  }
  const networkState = object(network.taskStateSample);
  const networkStates = [{
    taskId: hash(networkState.taskId), nativeStatusCode: networkState.nativeStatusCode,
    asOfBlock: integer(networkState.asOfBlock),
    submittedAt: networkState.submittedAtUnix === undefined ? null : unixTime(networkState.submittedAtUnix),
    cryptographicVerification: 'not_run' as const,
  }];
  const observedCore = {
    schemaVersion: '1.0.0' as const,
    finance: {
      chainId: 56 as const, contracts,
      coverage: {
        chainId: 56, contractAddresses: contracts.map(contract => contract.address),
        fromBlock: integer(financeRange.fromBlock), toBlock: integer(financeRange.toBlock),
        fromTime: unixTime(window.fromTimestampUnix), toTime: unixTime(window.toTimestampUnix),
        observedAt: instant(finance.startedAtUtc), completeForRegisteredContracts: object(finance.scan).complete === true,
        finality: 'provider_reported_finalized' as const, sourceId: 'bsc-publicnode',
      },
      events: financeEvents,
      stateSamples: list(native.stateSamples).map(sample => ({
        contractAddress: address(sample.contractAddress), batchId: integer(sample.batchId),
        nativeStateCode: sample.nativeStateCode, asOfBlock: integer(sample.asOfBlock),
      })),
      latencySamples,
    },
    network: {
      chainId: 8453 as const, taskContract: address(network.contractAddress),
      coverage: {
        chainId: 8453, contractAddresses: [address(network.contractAddress)],
        fromBlock: integer(networkTrial.fromBlock), toBlock: integer(networkTrial.toBlock),
        fromTime: null, toTime: unixTime(networkHeader.timestampUnix),
        observedAt: instant(network.capturedAtUtc), completeForRegisteredContracts: true,
        finality: 'provider_reported_finalized' as const, sourceId: 'base-publicnode',
      },
      events: networkEvents, stateSamples: networkStates,
    },
    sources: [
      { id: 'bsc-publicnode', label: 'BNB Smart Chain · PublicNode', kind: 'rpc' as const, url: 'https://bsc-rpc.publicnode.com' },
      { id: 'base-publicnode', label: 'Primus Network · Base PublicNode', kind: 'rpc' as const, url: 'https://base-rpc.publicnode.com' },
      { id: 'primus-finance-frontend', label: 'Primus official Finance configuration', kind: 'official_frontend' as const, url: text(object(registry.source).configurationUrl) },
      { id: 'primus-finance-docs', label: 'Primus Confidential Finance documentation', kind: 'official_docs' as const, url: text(object(registry.source).documentationUrl) },
      { id: 'primus-network-docs', label: 'Primus Network documentation', kind: 'official_docs' as const, url: 'https://docs.primuslabs.xyz/primus-network/understand-primus-network/' },
      { id: 'mint-implementation-source', label: 'Mint aggregator verified source', kind: 'verified_source_metadata' as const, url: 'https://bscscan.com/address/0x8b6213044534be95c7d889594cedaaee7757c29d#code' },
      { id: 'redeem-implementation-source', label: 'Redeem aggregator verified source', kind: 'verified_source_metadata' as const, url: 'https://bscscan.com/address/0xa2652e6c1a825a18567fa670ff9b4416039aad46#code' },
    ],
    features: {
      privatePositions: 'unavailable' as const,
      attestationVerification: 'not_implemented' as const,
      developerTelemetry: 'not_configured' as const,
    },
  };
  const timePath=join(root,'docs/discovery/calendar-block-times.json');
  if(existsSync(timePath)){
    const evidence=object(JSON.parse(readFileSync(timePath,'utf8')));
    const times=new Map(list(evidence.blocks).map(row=>[integer(row.chainId)+':'+integer(row.blockNumber),
      {blockHash:hash(row.blockHash),timestamp:instant(row.timestamp)}]));
    for(const domain of [observedCore.finance,observedCore.network]){
      for(const event of domain.events){
        const timed=times.get(domain.chainId+':'+event.blockNumber);if(!timed)continue;
        if(timed.blockHash!==event.blockHash||(event.timestamp!==null&&event.timestamp!==timed.timestamp))throw new Error('SOURCE_TIMESTAMP_MISMATCH');
        event.timestamp=timed.timestamp;
      }
      const boundary=list(evidence.boundaries).find(row=>integer(row.chainId)===String(domain.chainId)&&integer(row.fromBlock)===domain.coverage.fromBlock);
      if(boundary){
        const start=instant(boundary.fromTime);
        if(domain.coverage.fromTime!==null&&domain.coverage.fromTime!==start)throw new Error('SOURCE_TIMESTAMP_MISMATCH');
        domain.coverage.fromTime=start;
      }
    }
  }
  // Import time is not part of snapshot identity or source freshness.
  const snapshotId = digest(observedCore);
  return ObservationSetSchema.parse({ ...observedCore, snapshotId, generatedAt: generatedAt.toISOString() });
}

export function importObservations(root = rootDirectory(), generatedAt = new Date()) {
  const snapshot = buildObservationSet(root, generatedAt);
  const path = join(root, 'data/observations/current.json');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n');
  renameSync(temporary, path);
  return { path, snapshotId: snapshot.snapshotId, financeEvents: snapshot.finance.events.length, networkEvents: snapshot.network.events.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(importObservations()));
  } catch {
    console.error('Observation import failed: source evidence is missing, inconsistent, or invalid.');
    process.exitCode = 1;
  }
}
