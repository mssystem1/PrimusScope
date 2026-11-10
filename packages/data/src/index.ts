import { createHash } from 'node:crypto';
import {
  ObservationSetSchema, NetworkEventFiltersSchema,
  type Coverage,
  type FinanceEvent,
  type NetworkEvent,
  type ObservationSet,
  type NetworkEventFilters,
} from '@primusscope/api-schema';
import {
  DataAccessError, getServingState, type ServingContext, type ServingMode,
} from './serving';
export * from './serving';
export * from './analytics';
export * from './strategy-analytics';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FRESHNESS_SECONDS = 300;
export const MAX_EXPORT_ROWS = 5_000;
const FINANCE_STATE_NAMES = ['Open', 'Dispatched', 'Finalized', 'Canceled'] as const;
const NETWORK_STATE_NAMES = ['INIT', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_SUCCESS_SETTLED', 'FAILED'] as const;

export type Freshness = {
  mode: ServingMode;
  state: 'recorded' | 'fresh' | 'stale' | 'clock_skew';
  observedAt: string;
  sourceAsOf: string;
  ageSeconds: string;
  staleAfterSeconds: number;
};

export function getFreshness(coverage: Coverage, now = new Date(), mode: ServingMode = 'recorded_observations', staleAfterSeconds = FRESHNESS_SECONDS): Freshness {
  const seconds = (now.getTime() - new Date(coverage.observedAt).getTime()) / 1000;
  if (!Number.isFinite(seconds)) throw new DataAccessError('INVALID_TIME', 'A valid observation clock is required.');
  return {
    mode,
    state: seconds < -30 ? 'clock_skew' : seconds > staleAfterSeconds ? 'stale'
      : mode === 'indexed_observations' ? 'fresh' : 'recorded',
    observedAt: coverage.observedAt,
    sourceAsOf: coverage.toTime,
    ageSeconds: String(Math.max(0, Math.floor(seconds))),
    staleAfterSeconds,
  };
}

export type FinanceBatch = {
  id: string;
  chainId: 56;
  routeId: string;
  contractAddress: string;
  role: 'deposit' | 'redeem';
  batchId: string;
  eventCount: number;
  firstObservedBlock: string;
  lastObservedBlock: string;
  nativeState: { code: number; name: string; asOfBlock: string } | null;
  observedState: string;
  stateOrigin: 'native_snapshot' | 'event_observation';
  events: FinanceEvent[];
  dispatchToFinalizedSeconds: string | null;
};

export type FinanceBatchFilters = {
  routeId?: string;
  contractAddress?: string;
  cursor?: string;
  limit?: number;
};

export type NetworkEventPageOptions = NetworkEventFilters & { cursor?: string; limit?: number };
export type MetricsExportOptions = NetworkEventFilters & {
  domain?: 'finance' | 'network'; routeId?: string; snapshotId?: string;
};

export type LookupInput = {
  type?: 'auto' | 'task' | 'transaction' | 'contract' | 'address';
  identifier: string;
  chainId?: number;
  contractAddress?: string;
};

export type LookupMatch = {
  type: 'task' | 'transaction' | 'contract';
  id: string;
  label: string;
  chainId: number;
  href: string;
  contractAddress?: string;
  taskId?: string;
  transactionHash?: string;
};

function canonicalAddress(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new DataAccessError('INVALID_IDENTIFIER', 'Use a valid 20-byte contract address.');
  }
  return value.toLowerCase();
}

function canonicalHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new DataAccessError('INVALID_IDENTIFIER', 'Use a valid 32-byte transaction hash or task ID.');
  }
  return value.toLowerCase();
}

function canonicalDecimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 78 || !DECIMAL.test(value) || BigInt(value) >= 2n ** 256n) {
    throw new DataAccessError('INVALID_IDENTIFIER', 'Use a canonical non-negative integer identifier.');
  }
  return value;
}

function compareIntegers(a: string, b: string): number {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}

function eventOrder(a: FinanceEvent | NetworkEvent, b: FinanceEvent | NetworkEvent): number {
  return compareIntegers(a.blockNumber, b.blockNumber)
    || compareIntegers(a.logIndex, b.logIndex)
    || a.transactionHash.localeCompare(b.transactionHash);
}

function hashObject(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cursorFor(snapshotId: string, filterHash: string, lastId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, snapshotId, filterHash, lastId })).toString('base64url');
}

function readCursor(cursor: string, snapshotId: string, filterHash: string): string {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) {
    throw new DataAccessError('INVALID_CURSOR', 'This cursor is invalid; refresh the selected view.');
  }
  let payload: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new DataAccessError('INVALID_CURSOR', 'This cursor is invalid; refresh the selected view.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DataAccessError('INVALID_CURSOR', 'This cursor is invalid; refresh the selected view.');
  }
  const item = payload as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'filterHash,lastId,snapshotId,v'
    || item.v !== 1 || typeof item.snapshotId !== 'string' || typeof item.filterHash !== 'string'
    || typeof item.lastId !== 'string' || !item.lastId) {
    throw new DataAccessError('INVALID_CURSOR', 'This cursor is invalid; refresh the selected view.');
  }
  if (item.snapshotId !== snapshotId) {
    throw new DataAccessError('SNAPSHOT_EXPIRED', 'The observation snapshot changed; refresh before continuing.', 409);
  }
  if (item.filterHash !== filterHash) {
    throw new DataAccessError('INVALID_CURSOR', 'This cursor belongs to different filters; refresh the selected view.');
  }
  return item.lastId;
}

function financeGroups(snapshot: ObservationSet, events = snapshot.finance.events): FinanceBatch[] {
  const grouped = new Map<string, FinanceEvent[]>();
  for (const event of events) {
    const id = '56:' + event.contractAddress + ':' + event.batchId;
    const group = grouped.get(id) ?? [];
    group.push(event);
    grouped.set(id, group);
  }
  return [...grouped.entries()].map(([id, unordered]) => {
    const events = [...unordered].sort(eventOrder);
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const contract = snapshot.finance.contracts.find(c => c.address === first.contractAddress)!;
    const state = snapshot.finance.stateSamples.find(s => s.contractAddress === first.contractAddress && s.batchId === first.batchId);
    const latency = snapshot.finance.latencySamples.find(s => s.contractAddress === first.contractAddress && s.batchId === first.batchId);
    const stateEvent = [...events].reverse().find(e => ['AggregateDispatched', 'AggregateFinalized', 'AggregateCanceled'].includes(e.kind));
    const eventState = stateEvent?.kind === 'AggregateFinalized' ? 'Finalized'
      : stateEvent?.kind === 'AggregateCanceled' ? 'Canceled'
      : stateEvent?.kind === 'AggregateDispatched' ? 'Dispatched' : 'Unknown';
    return {
      id, chainId: 56 as const, routeId: contract.routeId, contractAddress: first.contractAddress,
      role: contract.role, batchId: first.batchId, eventCount: events.length,
      firstObservedBlock: first.blockNumber, lastObservedBlock: last.blockNumber,
      nativeState: state ? { code: state.nativeStateCode, name: FINANCE_STATE_NAMES[state.nativeStateCode], asOfBlock: state.asOfBlock } : null,
      observedState: state && (!stateEvent || BigInt(state.asOfBlock) >= BigInt(stateEvent.blockNumber))
        ? FINANCE_STATE_NAMES[state.nativeStateCode] : eventState,
      stateOrigin: state && (!stateEvent || BigInt(state.asOfBlock) >= BigInt(stateEvent.blockNumber))
        ? 'native_snapshot' as const : 'event_observation' as const,
      events, dispatchToFinalizedSeconds: latency?.seconds ?? null,
    };
  }).sort((a, b) => compareIntegers(b.lastObservedBlock, a.lastObservedBlock) || a.id.localeCompare(b.id));
}

export function sanitizeCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\t\r\n]|^[ \t\r\n]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function createRepository(input: ObservationSet, clock: () => Date = () => new Date(),
  context: ServingContext = { mode: 'recorded_observations', indexerStatus: null }) {
  const snapshot = ObservationSetSchema.parse(input);
  // The public schemas accept checksum casing. Normalize identity fields once
  // on our owned copy so filters and grouping use the same representation.
  for (const coverage of [snapshot.finance.coverage, snapshot.network.coverage]) {
    coverage.contractAddresses = coverage.contractAddresses.map(address => address.toLowerCase());
  }
  for (const contract of snapshot.finance.contracts) {
    contract.address = contract.address.toLowerCase();
    contract.implementationAddress = contract.implementationAddress.toLowerCase();
  }
  for (const sample of [...snapshot.finance.stateSamples, ...snapshot.finance.latencySamples]) {
    sample.contractAddress = sample.contractAddress.toLowerCase();
  }
  snapshot.network.taskContract = snapshot.network.taskContract.toLowerCase();
  for (const sample of snapshot.network.stateSamples) sample.taskId = sample.taskId.toLowerCase();
  for (const event of [...snapshot.finance.events, ...snapshot.network.events]) {
    event.contractAddress = event.contractAddress.toLowerCase();
    event.blockHash = event.blockHash.toLowerCase();
    event.transactionHash = event.transactionHash.toLowerCase();
    if ('taskId' in event && event.taskId !== null) event.taskId = event.taskId.toLowerCase();
  }
  const base = () => ({
    snapshotId: snapshot.snapshotId, mode: context.mode, generatedAt: snapshot.generatedAt,
    ...(context.indexerStatus ? { indexerStatus: context.indexerStatus } : {}),
  });
  const staleWindow = context.indexerStatus?.collectionMode === 'scheduled' && context.indexerStatus.intervalMinutes
    ? context.indexerStatus.intervalMinutes * 120 + 120 : FRESHNESS_SECONDS;
  const financeMetadata = () => ({
    coverage: snapshot.finance.coverage, freshness: getFreshness(snapshot.finance.coverage, clock(), context.mode, staleWindow),
  });
  const networkMetadata = () => ({
    coverage: snapshot.network.coverage, freshness: getFreshness(snapshot.network.coverage, clock(), context.mode, staleWindow),
  });

  function financeSelection(options: Pick<FinanceBatchFilters, 'routeId' | 'contractAddress'> = {}) {
    const routeIds = new Set(snapshot.finance.contracts.map(contract => contract.routeId));
    if (options.routeId !== undefined && (!routeIds.has(options.routeId) || typeof options.routeId !== 'string')) {
      throw new DataAccessError('UNSUPPORTED_SCOPE', 'That vault route is outside the recorded coverage.', 422);
    }
    const address = options.contractAddress === undefined ? undefined : canonicalAddress(options.contractAddress);
    if (address && !snapshot.finance.contracts.some(contract => contract.address === address
      && (!options.routeId || contract.routeId === options.routeId))) {
      throw new DataAccessError('UNSUPPORTED_SCOPE', 'That contract is outside the selected finance coverage.', 422);
    }
    const contracts = snapshot.finance.contracts.filter(contract => (!options.routeId || contract.routeId === options.routeId)
      && (!address || contract.address === address));
    const addresses = new Set(contracts.map(contract => contract.address));
    return { contracts, events: snapshot.finance.events.filter(event => addresses.has(event.contractAddress)), address };
  }

  function networkScope(chainId = 8453, address = snapshot.network.taskContract) {
    const canonical = canonicalAddress(address);
    if (chainId !== 8453 || canonical !== snapshot.network.taskContract) {
      throw new DataAccessError('UNSUPPORTED_SCOPE', 'That network contract is outside the recorded coverage.', 422);
    }
    return canonical;
  }

  function getSources() {
    return {
      ...base(),
      items: snapshot.sources.map(source => {
        const coverage = [snapshot.finance.coverage, snapshot.network.coverage].filter(scope => scope.sourceId === source.id);
        return {
          ...source,
          status: coverage.length ? context.mode === 'indexed_observations' ? 'indexed' : 'recorded' : 'reference',
          coverage,
          observations: coverage.map(scope => ({ chainId: scope.chainId, ...getFreshness(scope, clock(), context.mode, staleWindow) })),
        };
      }),
    };
  }

  function getFinanceVaults() {
    const routeIds = [...new Set(snapshot.finance.contracts.map(contract => contract.routeId))];
    const items = routeIds.map(id => {
      const selected = financeSelection({ routeId: id });
      const batches = financeGroups(snapshot, selected.events);
      return {
        id, label: id === 'united-stables-confidential-vault' ? 'U / eU' : 'USDT / eUSDT',
        chainId: 56 as const,
        depositAggregator: selected.contracts.find(contract => contract.role === 'deposit')?.address ?? null,
        redeemAggregator: selected.contracts.find(contract => contract.role === 'redeem')?.address ?? null,
        eventCount: selected.events.length, batchCount: batches.length,
        finalizedBatchCount: new Set(selected.events.filter(e => e.kind === 'AggregateFinalized').map(e => e.contractAddress + ':' + e.batchId)).size,
        apy: null, totalAssets: null,
        yieldAvailability: 'unsupported' as const,
        yieldReason: 'Route-specific returns are not public in this dataset. Shared strategy NAV/APY is available separately at /api/v1/finance/analytics.',
        holdingsAvailability: 'confidential' as const,
      };
    });
    return { ...base(), ...financeMetadata(), items };
  }

  function getFinanceVault(routeId: string) {
    const all = getFinanceVaults();
    const item = all.items.find(vault => vault.id === routeId);
    if (!item) throw new DataAccessError('NOT_FOUND_IN_COVERAGE', 'No supported vault matches this route.', 404);
    return { ...base(), ...financeMetadata(), ...item };
  }

  function getFinanceBatches(options: FinanceBatchFilters = {}) {
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DataAccessError('INVALID_FILTER', 'Page size must be an integer from 1 to 100.');
    }
    const selected = financeSelection(options);
    const groups = financeGroups(snapshot, selected.events);
    const filterHash = hashObject({ routeId: options.routeId ?? null, contractAddress: selected.address ?? null, limit });
    const lastId = options.cursor === undefined ? undefined : readCursor(options.cursor, snapshot.snapshotId, filterHash);
    const index = lastId === undefined ? -1 : groups.findIndex(group => group.id === lastId);
    if (lastId !== undefined && index < 0) throw new DataAccessError('INVALID_CURSOR', 'The cursor position is not in this view.');
    const items = groups.slice(index + 1, index + 1 + limit);
    const hasMore = index + 1 + items.length < groups.length;
    return {
      ...base(), ...financeMetadata(), items, total: groups.length,
      nextCursor: hasMore ? cursorFor(snapshot.snapshotId, filterHash, items[items.length - 1]!.id) : null,
    };
  }

  function getFinanceBatch(contractAddress: string, batchId: string) {
    const selected = financeSelection({ contractAddress });
    const id = canonicalDecimal(batchId);
    const batch = financeGroups(snapshot, selected.events).find(group => group.batchId === id);
    if (!batch) throw new DataAccessError('NOT_FOUND_IN_COVERAGE', 'No matching batch events were recorded in this block window.', 404);
    return { ...base(), ...financeMetadata(), ...batch };
  }

  function getNetworkSummary(options: { chainId?: number; contractAddress?: string } = {}) {
    networkScope(options.chainId, options.contractAddress);
    const events = snapshot.network.events;
    const from = BigInt(snapshot.network.coverage.fromBlock);
    const to = BigInt(snapshot.network.coverage.toBlock);
    const width = (to - from + 10n) / 10n;
    const blockBins = Array.from({ length: 10 }, (_, index) => {
      const start = from + BigInt(index) * width;
      const end = start + width - 1n > to ? to : start + width - 1n;
      const selected = events.filter(event => BigInt(event.blockNumber) >= start && BigInt(event.blockNumber) <= end);
      return {
        fromBlock: start.toString(), toBlock: end.toString(),
        requestCount: selected.filter(e => e.kind === 'SubmitTask').length,
        reportEventCount: selected.filter(e => e.kind === 'ReportResult').length,
        withdrawalEventCount: selected.filter(e => e.kind === 'WithdrawBalance').length,
      };
    }).filter(bin => BigInt(bin.fromBlock) <= to);
    return {
      ...base(), ...networkMetadata(), chainId: 8453 as const, contractAddress: snapshot.network.taskContract,
      totalEvents: events.length,
      requestCount: new Set(events.filter(e => e.kind === 'SubmitTask' && e.taskId).map(e => e.taskId)).size,
      reportEventCount: events.filter(e => e.kind === 'ReportResult').length,
      withdrawalEventCount: events.filter(e => e.kind === 'WithdrawBalance').length,
      callbackFailureEventCount: events.filter(e => e.kind === 'CallbackFailed').length,
      nativeStateSampleCount: snapshot.network.stateSamples.length,
      successRate: null, verifiedProofCount: null, blockBins,
    };
  }

  function networkEventSelection(input: NetworkEventFilters = {}) {
    const parsed = NetworkEventFiltersSchema.safeParse(input);
    if (!parsed.success) throw new DataAccessError('INVALID_FILTER', 'Check the Network event filters and identifier formats.');
    const options = parsed.data;
    const contractAddress = networkScope(options.chainId, options.contractAddress);
    const coverage = snapshot.network.coverage;
    const fromBlock = options.fromBlock ?? coverage.fromBlock, toBlock = options.toBlock ?? coverage.toBlock;
    if (BigInt(fromBlock) > BigInt(toBlock)) throw new DataAccessError('INVALID_FILTER', 'The start block must not exceed the end block.');
    if (BigInt(fromBlock) < BigInt(coverage.fromBlock) || BigInt(toBlock) > BigInt(coverage.toBlock)) {
      throw new DataAccessError('UNSUPPORTED_SCOPE', 'Select a block range within the published Network coverage.', 422);
    }
    const taskId = options.taskId?.toLowerCase() ?? null;
    const selection = { chainId: 8453 as const, contractAddress, fromBlock, toBlock,
      eventKind: options.eventKind ?? null, taskId };
    const events = snapshot.network.events.filter(event => BigInt(event.blockNumber) >= BigInt(fromBlock)
      && BigInt(event.blockNumber) <= BigInt(toBlock)
      && (!selection.eventKind || event.kind === selection.eventKind)
      && (!taskId || event.taskId === taskId)).sort((a, b) => eventOrder(b, a));
    return { selection, events };
  }

  function getNetworkEvents(options: NetworkEventPageOptions = {}) {
    const { limit = 25, cursor, ...filters } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DataAccessError('INVALID_FILTER', 'Page size must be an integer from 1 to 100.');
    }
    const { selection, events } = networkEventSelection(filters);
    const filterHash = hashObject({ resource: 'network.events.v1', ...selection, limit });
    const lastId = cursor === undefined ? undefined : readCursor(cursor, snapshot.snapshotId, filterHash);
    const index = lastId === undefined ? -1 : events.findIndex(event => event.id === lastId);
    if (lastId !== undefined && index < 0) throw new DataAccessError('INVALID_CURSOR', 'The cursor position is not in this view.');
    const items = events.slice(index + 1, index + 1 + limit);
    return { ...base(), ...networkMetadata(), selection, items, total: events.length,
      pageStart: items.length ? index + 2 : 0, pageEnd: index + 1 + items.length,
      exportRowLimit: MAX_EXPORT_ROWS,
      nextCursor: index + 1 + items.length < events.length
        ? cursorFor(snapshot.snapshotId, filterHash, items[items.length - 1]!.id) : null };
  }

  function getNetworkTask(chainId: number, contractAddress: string, taskId: string) {
    const contract = networkScope(chainId, contractAddress);
    const id = canonicalHash(taskId);
    const events = snapshot.network.events.filter(event => event.taskId === id).sort(eventOrder);
    if (!events.length) throw new DataAccessError('NOT_FOUND_IN_COVERAGE', 'No matching task events were recorded in this block window.', 404);
    const state = snapshot.network.stateSamples.find(sample => sample.taskId === id);
    return {
      ...base(), ...networkMetadata(), chainId: 8453 as const, contractAddress: contract, taskId: id,
      requestObserved: events.some(e => e.kind === 'SubmitTask'),
      reportEventCount: events.filter(e => e.kind === 'ReportResult').length,
      nativeState: state ? { code: state.nativeStatusCode, name: NETWORK_STATE_NAMES[state.nativeStatusCode],
        asOfBlock: state.asOfBlock, submittedAt: state.submittedAt } : null,
      cryptographicVerification: 'not_run' as const, events,
    };
  }

  function getOverview() {
    const groups = financeGroups(snapshot);
    const summary = getNetworkSummary();
    return {
      ...base(),
      finance: {
        ...financeMetadata(), chainId: 56 as const, eventCount: snapshot.finance.events.length,
        batchCount: groups.length,
        finalizedBatchCount: new Set(snapshot.finance.events.filter(e => e.kind === 'AggregateFinalized').map(e => e.contractAddress + ':' + e.batchId)).size,
        apy: null, tvl: null, sampleLatencySeconds: snapshot.finance.latencySamples[0]?.seconds ?? null,
      },
      network: summary, features: snapshot.features,
    };
  }

  function lookupIdentifier(input: LookupInput) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['identifier', 'type', 'chainId', 'contractAddress'].includes(key))) {
      throw new DataAccessError('INVALID_IDENTIFIER', 'Provide a supported public identifier lookup.');
    }
    if (typeof input.identifier !== 'string' || input.identifier.length > 256) {
      throw new DataAccessError('INVALID_IDENTIFIER', 'Provide a supported public identifier of at most 256 characters.');
    }
    const type = input.type ?? 'auto';
    if (!['auto', 'task', 'transaction', 'contract', 'address'].includes(type)) {
      throw new DataAccessError('INVALID_IDENTIFIER', 'Select a supported identifier type.');
    }
    const id = input.identifier.trim().toLowerCase();
    if (input.chainId !== undefined && ![56, 8453].includes(input.chainId)) {
      throw new DataAccessError('UNSUPPORTED_SCOPE', 'That chain is outside the recorded coverage.', 422);
    }
    const contractFilter = input.contractAddress === undefined ? undefined : canonicalAddress(input.contractAddress);
    const hashType = ['auto', 'task', 'transaction'].includes(type) && HASH.test(id);
    const addressType = ['auto', 'contract', 'address'].includes(type) && ADDRESS.test(id);
    if (!hashType && !addressType) throw new DataAccessError('INVALID_IDENTIFIER', 'Use a public transaction hash, task ID or supported contract address.');
    const matches: LookupMatch[] = [];
    if (addressType) {
      for (const contract of snapshot.finance.contracts) {
        if (contract.address === id && (!input.chainId || input.chainId === 56) && (!contractFilter || contractFilter === id)) {
          matches.push({ type: 'contract', id: '56:' + id, label: contract.role + ' aggregator · ' + contract.routeId,
            chainId: 56, contractAddress: id, href: '/finance/vaults/' + contract.routeId });
        }
      }
      if (snapshot.network.taskContract === id && (!input.chainId || input.chainId === 8453)
        && (!contractFilter || contractFilter === id)) {
        matches.push({ type: 'contract', id: '8453:' + id, label: 'Primus network task contract', chainId: 8453,
          contractAddress: id, href: '/network' });
      }
    }
    if (hashType) {
      if (type !== 'transaction' && (!input.chainId || input.chainId === 8453)
        && (!contractFilter || contractFilter === snapshot.network.taskContract)
        && snapshot.network.events.some(event => event.taskId === id)) {
        matches.push({ type: 'task', id: '8453:' + snapshot.network.taskContract + ':' + id,
          label: 'Network task ' + id.slice(0, 10), chainId: 8453, contractAddress: snapshot.network.taskContract,
          taskId: id, href: '/network/tasks/8453/' + snapshot.network.taskContract + '/' + id });
      }
      if (type !== 'task') {
        const financeEvent = snapshot.finance.events.find(event => event.transactionHash === id
          && (!input.chainId || input.chainId === 56) && (!contractFilter || contractFilter === event.contractAddress));
        if (financeEvent) {
          const contract = snapshot.finance.contracts.find(c => c.address === financeEvent.contractAddress)!;
          matches.push({ type: 'transaction', id: '56:tx:' + id, label: 'Finance transaction ' + id.slice(0, 10),
            chainId: 56, contractAddress: financeEvent.contractAddress, transactionHash: id,
            href: '/finance/vaults/' + contract.routeId + '#batch-' + financeEvent.contractAddress + '-' + financeEvent.batchId });
        }
        const networkEvents = snapshot.network.events.filter(event => event.transactionHash === id
          && (!input.chainId || input.chainId === 8453) && (!contractFilter || contractFilter === event.contractAddress));
        const ids = [...new Set(networkEvents.map(event => event.taskId).filter((value): value is string => value !== null))];
        for (const taskId of ids) {
          matches.push({ type: 'transaction', id: '8453:tx:' + id + ':' + taskId, label: 'Network transaction ' + id.slice(0, 10),
            chainId: 8453, contractAddress: snapshot.network.taskContract, transactionHash: id, taskId,
            href: '/network/tasks/8453/' + snapshot.network.taskContract + '/' + taskId });
        }
        if (networkEvents.length && !ids.length) {
          matches.push({ type: 'transaction', id: '8453:tx:' + id, label: 'Network transaction ' + id.slice(0, 10),
            chainId: 8453, contractAddress: snapshot.network.taskContract, transactionHash: id, href: '/network' });
        }
      }
    }
    return { ...base(), matches, coverage: [snapshot.finance.coverage, snapshot.network.coverage] };
  }

  function exportMetricsCsv(options: MetricsExportOptions = {}) {
    const domain = options.domain ?? 'finance';
    if (!['finance', 'network'].includes(domain)) throw new DataAccessError('INVALID_FILTER', 'Select finance or network for export.');
    if (options.snapshotId !== undefined && options.snapshotId !== snapshot.snapshotId) {
      throw new DataAccessError('SNAPSHOT_EXPIRED', 'The observation snapshot changed; refresh before exporting.', 409);
    }
    const coverage = domain === 'finance' ? snapshot.finance.coverage : snapshot.network.coverage;
    let events: (FinanceEvent | NetworkEvent)[];
    let selectionFrom = coverage.fromBlock, selectionTo = coverage.toBlock;
    if (domain === 'finance') {
      if ([options.chainId, options.fromBlock, options.toBlock, options.eventKind, options.taskId].some(value => value !== undefined)) {
        throw new DataAccessError('INVALID_FILTER', 'Network event filters do not apply to Finance exports.');
      }
      events = financeSelection(options).events;
    } else {
      if (options.routeId !== undefined) throw new DataAccessError('INVALID_FILTER', 'Vault filters do not apply to network exports.');
      const selected = networkEventSelection({ chainId: options.chainId, contractAddress: options.contractAddress,
        fromBlock: options.fromBlock, toBlock: options.toBlock, eventKind: options.eventKind, taskId: options.taskId });
      events = selected.events; selectionFrom = selected.selection.fromBlock; selectionTo = selected.selection.toBlock;
    }
    if (events.length > MAX_EXPORT_ROWS) throw new DataAccessError('RANGE_TOO_LARGE', 'This export exceeds the bounded row limit.', 422);
    const source = snapshot.sources.find(item => item.id === coverage.sourceId)!;
    const header = ['domain', 'chain_id', 'contract_address', 'event', 'task_id', 'batch_id', 'block_number',
      'transaction_hash', 'log_index', 'source_id', 'source_url', 'observed_at', 'coverage_from_block',
      'coverage_to_block', 'snapshot_id', 'definition_version', 'data_mode', 'event_timestamp_utc',
      'selection_from_block', 'selection_to_block', 'event_kind_filter', 'task_id_filter'];
    const rows = events.map(event => [
      domain, coverage.chainId, event.contractAddress, event.kind,
      'taskId' in event ? event.taskId : '', 'batchId' in event ? event.batchId : '', event.blockNumber,
      event.transactionHash, event.logIndex, event.sourceId, source.url, coverage.observedAt,
      coverage.fromBlock, coverage.toBlock, snapshot.snapshotId, '1.0.0', context.mode, event.timestamp,
      selectionFrom, selectionTo, options.eventKind ?? '', options.taskId?.toLowerCase() ?? '',
    ]);
    return [header, ...rows].map(row => row.map(sanitizeCsvCell).join(',')).join('\r\n') + '\r\n';
  }

  return {
    getOverview, getSources, getFinanceVaults, getFinanceVault, getFinanceBatches, getFinanceBatch,
    getNetworkSummary, getNetworkEvents, getNetworkTask, lookupIdentifier, exportMetricsCsv,
  };
}

const repository = async () => {
  const { snapshot, ...context } = await getServingState();
  return createRepository(snapshot, () => new Date(), context);
};
export const getOverview = async () => (await repository()).getOverview();
export const getSources = async () => (await repository()).getSources();
export const getFinanceVaults = async () => (await repository()).getFinanceVaults();
export const getFinanceVault = async (routeId: string) => (await repository()).getFinanceVault(routeId);
export const getFinanceBatches = async (options: FinanceBatchFilters = {}) => (await repository()).getFinanceBatches(options);
export const getFinanceBatch = async (contractAddress: string, batchId: string) => (await repository()).getFinanceBatch(contractAddress, batchId);
export const getNetworkSummary = async (options: { chainId?: number; contractAddress?: string } = {}) => (await repository()).getNetworkSummary(options);
export const getNetworkEvents = async (options: NetworkEventPageOptions = {}) => (await repository()).getNetworkEvents(options);
export const getNetworkTask = async (chainId: number, contractAddress: string, taskId: string) => (await repository()).getNetworkTask(chainId, contractAddress, taskId);
export const lookupIdentifier = async (input: LookupInput) => (await repository()).lookupIdentifier(input);
export const exportMetricsCsv = async (options: MetricsExportOptions = {}) => (await repository()).exportMetricsCsv(options);
