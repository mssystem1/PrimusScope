import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildObservationSet } from '../../../scripts/import-observations';
import {
  createRepository, DataAccessError, getFreshness,
  getObservationSet, sanitizeCsvCell,
} from './index';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const snapshot = await getObservationSet();
const clock = () => new Date('2026-11-09T09:00:00Z');
const repository = () => createRepository(snapshot, clock);
const USDT = 'encrypted-usdt-confidential-vault';
const U = 'united-stables-confidential-vault';
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function expectError(run: () => unknown, code: string, status: number) {
  try {
    run();
    throw new Error('Expected a typed data error');
  } catch (error) {
    expect(error).toBeInstanceOf(DataAccessError);
    expect(error).toMatchObject({ code, status });
  }
}

// Every generated cell is quoted. This reader also handles doubled quotes.
function readCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const character = csv[index]!;
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') { cells.push(cell); cell = ''; }
    else if (!quoted && character === '\r' && csv[index + 1] === '\n') {
      cells.push(cell); rows.push(cells); cell = ''; cells = []; index++;
    } else cell += character;
  }
  const headers = rows.shift()!;
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]!])));
}

describe('recorded real observation serving', () => {
  it('keeps finance activity, requests, report events and withdrawals distinct', () => {
    const overview = repository().getOverview();
    expect(overview.finance).toMatchObject({ chainId: 56, eventCount: 9, batchCount: 4, finalizedBatchCount: 2 });
    expect(overview.network).toMatchObject({
      chainId: 8453, totalEvents: 223, requestCount: 116,
      reportEventCount: 90, withdrawalEventCount: 17, nativeStateSampleCount: 1,
    });
    expect(overview.finance.apy).toBeNull();
    expect(overview.finance.tvl).toBeNull();
    expect(overview.network.successRate).toBeNull();
    expect(overview.network.verifiedProofCount).toBeNull();
    expect(overview.features.privatePositions).toBe('unavailable');
  });

  it('bases freshness on source observation time even when data is imported again', () => {
    const reimported = buildObservationSet(root, new Date('2026-11-09T09:00:00Z'));
    const overview = createRepository(reimported, clock).getOverview();
    expect(overview.generatedAt).toBe('2026-11-09T09:00:00.000Z');
    expect(overview.finance.freshness.state).toBe('stale');
    expect(overview.network.freshness.state).toBe('stale');
    expect(overview.finance.freshness.observedAt).toBe(snapshot.finance.coverage.observedAt);
    expect(overview.finance.freshness.ageSeconds).toBe('4410');
    expect(overview.finance.freshness.mode).toBe('recorded_observations');
    expect(reimported.snapshotId).toBe(snapshot.snapshotId);
  });

  it('never labels a recorded snapshot live, and detects a source clock ahead of the server', () => {
    expect(getFreshness(snapshot.finance.coverage, new Date(snapshot.finance.coverage.observedAt)))
      .toMatchObject({ mode: 'recorded_observations', state: 'recorded', ageSeconds: '0' });
    expect(getFreshness(snapshot.finance.coverage, new Date('2026-11-09T00:00:00Z')))
      .toMatchObject({ state: 'clock_skew', ageSeconds: '0' });
  });

  it('preserves the real block window and the reconciled block-header calendar times', () => {
    expect(snapshot.finance.coverage).toMatchObject({
      fromBlock: '132495502', toBlock: '132545501',
      fromTime: '2026-11-09T01:20:18.000Z', toTime: '2026-11-09T07:35:25.000Z',
    });
    expect(snapshot.finance.events.filter(event => event.timestamp !== null)).toHaveLength(9);
    expect(snapshot.network.events.every(event => event.timestamp !== null)).toBe(true);
    expect(snapshot.network.coverage.fromTime).not.toBeNull();
    const summary = repository().getNetworkSummary();
    expect(summary.blockBins.reduce((count, bin) => count + bin.requestCount, 0)).toBe(116);
    expect(summary.blockBins.reduce((count, bin) => count + bin.reportEventCount, 0)).toBe(90);
    expect(summary.blockBins.reduce((count, bin) => count + bin.withdrawalEventCount, 0)).toBe(17);
    expect(Object.keys(summary.blockBins[0]!)).not.toContain('timestamp');
  });

  it('scopes vault counts to recorded contracts and retains supported empty results', () => {
    const vaults = repository().getFinanceVaults();
    expect(vaults.items).toHaveLength(2);
    expect(vaults.items.find(vault => vault.id === USDT)).toMatchObject({ eventCount: 7, batchCount: 3, apy: null, totalAssets: null });
    expect(vaults.items.find(vault => vault.id === U)).toMatchObject({ eventCount: 2, batchCount: 1, holdingsAvailability: 'confidential' });
    const emptyContract = snapshot.finance.contracts.find(contract => contract.routeId === U && contract.role === 'redeem')!.address;
    expect(repository().getFinanceBatches({ routeId: U, contractAddress: emptyContract })).toMatchObject({ items: [], total: 0, nextCursor: null });
    expectError(() => repository().getFinanceBatches({ routeId: 'unknown' }), 'UNSUPPORTED_SCOPE', 422);
  });

  it('exposes native finance state and measured latency only for the sampled batch', () => {
    const sample = snapshot.finance.stateSamples[0]!;
    expect(repository().getFinanceBatch(sample.contractAddress, sample.batchId)).toMatchObject({
      batchId: '146', nativeState: { code: 2, name: 'Finalized', asOfBlock: '132545501' },
      stateOrigin: 'native_snapshot', dispatchToFinalizedSeconds: '55',
    });
    const unsampled = repository().getFinanceBatches().items.find(batch => batch.batchId === '7')!;
    expect(unsampled).toMatchObject({ nativeState: null, observedState: 'Dispatched', dispatchToFinalizedSeconds: null });
    expectError(() => repository().getFinanceBatch(sample.contractAddress, '999999'), 'NOT_FOUND_IN_COVERAGE', 404);
  });

  it('reports sample SUCCESS as native state without claiming a verified proof', () => {
    const sample = snapshot.network.stateSamples[0]!;
    const detail = repository().getNetworkTask(8453, snapshot.network.taskContract, sample.taskId);
    expect(detail).toMatchObject({
      taskId: sample.taskId, requestObserved: true, reportEventCount: 1,
      nativeState: { code: 1, name: 'SUCCESS', asOfBlock: '55091641' }, cryptographicVerification: 'not_run',
    });
    expect(detail.events.every(event => event.taskId === sample.taskId)).toBe(true);
  });

  it('treats reports without a request in the window as incomplete lifecycle evidence', () => {
    const submitted = new Set(snapshot.network.events.filter(event => event.kind === 'SubmitTask').map(event => event.taskId));
    const report = snapshot.network.events.find(event => event.kind === 'ReportResult' && !submitted.has(event.taskId))!;
    const detail = repository().getNetworkTask(8453, snapshot.network.taskContract, report.taskId!);
    expect(detail).toMatchObject({ requestObserved: false, reportEventCount: 1, nativeState: null, cryptographicVerification: 'not_run' });
  });

  it('distinguishes a missing task in coverage from unsupported chain or contract', () => {
    const missing = '0x' + 'ff'.repeat(32);
    expectError(() => repository().getNetworkTask(8453, snapshot.network.taskContract, missing), 'NOT_FOUND_IN_COVERAGE', 404);
    expectError(() => repository().getNetworkTask(56, snapshot.network.taskContract, missing), 'UNSUPPORTED_SCOPE', 422);
    expectError(() => repository().getNetworkTask(8453, '0x' + 'ff'.repeat(20), missing), 'UNSUPPORTED_SCOPE', 422);
    expectError(() => repository().getNetworkTask(8453, snapshot.network.taskContract, '0x123'), 'INVALID_IDENTIFIER', 400);
  });

  it('pairs recorded sources with their bounded coverage and never marks references fetched', () => {
    const sources = repository().getSources();
    expect(sources.items.filter(source => source.status === 'recorded')).toHaveLength(2);
    expect(sources.items.filter(source => source.status === 'reference').every(source => source.coverage.length === 0)).toBe(true);
    expect(sources.items.filter(source => source.kind === 'rpc').every(source => source.observations[0]?.state === 'stale')).toBe(true);
  });
});

describe('pagination and public lookup', () => {
  it('reconciles every batch exactly once across a cursor-bound selected route', () => {
    const data = repository();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = data.getFinanceBatches({ routeId: USDT, limit: 1, cursor });
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(1);
      ids.push(page.items[0]!.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(data.getFinanceBatches({ routeId: USDT }).items.map(batch => batch.id));
  });

  it('rejects cursors when filters or snapshot change instead of returning mixed pages', () => {
    const cursor = repository().getFinanceBatches({ routeId: USDT, limit: 1 }).nextCursor!;
    expectError(() => repository().getFinanceBatches({ routeId: U, limit: 1, cursor }), 'INVALID_CURSOR', 400);
    expectError(() => repository().getFinanceBatches({ routeId: USDT, limit: 2, cursor }), 'INVALID_CURSOR', 400);
    const changed = structuredClone(snapshot);
    changed.snapshotId = 'a'.repeat(64);
    expectError(() => createRepository(changed).getFinanceBatches({ routeId: USDT, limit: 1, cursor }), 'SNAPSHOT_EXPIRED', 409);
    expectError(() => repository().getFinanceBatches({ cursor: 'not-a-valid-cursor' }), 'INVALID_CURSOR', 400);
    expectError(() => repository().getFinanceBatches({ limit: 101 }), 'INVALID_FILTER', 400);
  });

  it('resolves only public identifier evidence with explicit canonical destinations', () => {
    const sample = snapshot.network.stateSamples[0]!;
    const task = repository().lookupIdentifier({ identifier: sample.taskId, type: 'task' });
    expect(task.matches[0]).toMatchObject({ type: 'task', chainId: 8453, taskId: sample.taskId });
    expect(task.matches[0]!.href).toBe('/network/tasks/8453/' + snapshot.network.taskContract + '/' + sample.taskId);
    const financeEvent = snapshot.finance.events[0]!;
    const transaction = repository().lookupIdentifier({ identifier: financeEvent.transactionHash, type: 'transaction', chainId: 56 });
    expect(transaction.matches[0]).toMatchObject({ type: 'transaction', transactionHash: financeEvent.transactionHash });
    expect(transaction.matches[0]!.href).toContain('/finance/vaults/' + USDT + '#batch-');
    const contract = repository().lookupIdentifier({ identifier: snapshot.network.taskContract, type: 'contract' });
    expect(contract.matches[0]).toMatchObject({ type: 'contract', href: '/network' });
    expect(repository().lookupIdentifier({ identifier: sample.taskId, chainId: 56 }).matches).toEqual([]);
  });

  it('matches schema-valid mixed-case identities across contracts, events, samples and filters', () => {
    const input = structuredClone(snapshot);
    const uppercaseHex = (value: string) => '0x' + value.slice(2).toUpperCase();
    input.finance.contracts.forEach(contract => { contract.address = uppercaseHex(contract.address); });
    input.finance.coverage.contractAddresses = input.finance.coverage.contractAddresses.map(uppercaseHex);
    input.finance.stateSamples.forEach(sample => { sample.contractAddress = uppercaseHex(sample.contractAddress); });
    input.network.taskContract = uppercaseHex(input.network.taskContract);
    input.network.stateSamples.forEach(sample => { sample.taskId = uppercaseHex(sample.taskId); });
    input.network.events.forEach(event => {
      event.transactionHash = uppercaseHex(event.transactionHash);
      if (event.taskId !== null) event.taskId = uppercaseHex(event.taskId);
    });
    const data = createRepository(input, clock);
    const batchSample = snapshot.finance.stateSamples[0]!;
    expect(data.getFinanceBatches({ routeId: USDT }).items).toHaveLength(3);
    expect(data.getFinanceBatch(uppercaseHex(batchSample.contractAddress), batchSample.batchId).nativeState?.name).toBe('Finalized');
    const taskSample = snapshot.network.stateSamples[0]!;
    expect(data.getNetworkTask(8453, uppercaseHex(snapshot.network.taskContract), uppercaseHex(taskSample.taskId)).nativeState?.name).toBe('SUCCESS');
    expect(data.lookupIdentifier({ identifier: taskSample.taskId }).matches[0]?.type).toBe('task');
    expect(data.lookupIdentifier({ identifier: snapshot.network.events[0]!.transactionHash, type: 'transaction' }).matches.length).toBeGreaterThan(0);
    expect(input.finance.contracts[0]!.address).not.toBe(snapshot.finance.contracts[0]!.address);
  });

  it('returns both possible meanings when an auto hash matches a task ID and transaction', () => {
    const input = structuredClone(snapshot);
    const taskId = input.network.stateSamples[0]!.taskId;
    const originalTransaction = input.finance.events[0]!.transactionHash;
    input.finance.events = input.finance.events.map(event => event.transactionHash === originalTransaction
      ? { ...event, transactionHash: taskId } : event);
    const result = createRepository(input).lookupIdentifier({ identifier: taskId });
    expect(new Set(result.matches.map(match => match.type))).toEqual(new Set(['task', 'transaction']));
  });

  it('rejects malformed or private lookup payloads without echoing their content', () => {
    const secretLike = 'private viewing material';
    expectError(() => repository().lookupIdentifier({ identifier: secretLike }), 'INVALID_IDENTIFIER', 400);
    expectError(() => repository().lookupIdentifier({ identifier: snapshot.network.taskContract, viewingKey: secretLike } as never), 'INVALID_IDENTIFIER', 400);
    expectError(() => repository().lookupIdentifier({ identifier: snapshot.network.taskContract, chainId: 1 }), 'UNSUPPORTED_SCOPE', 422);
    try { repository().lookupIdentifier({ identifier: secretLike }); }
    catch (error) { expect(String(error)).not.toContain(secretLike); }
  });
});

describe('bounded source-traceable exports', () => {
  it('exports the same seven finance event identities as the selected route and no other contracts', () => {
    const data = repository();
    const rows = readCsv(data.exportMetricsCsv({ domain: 'finance', routeId: USDT }));
    const events = data.getFinanceBatches({ routeId: USDT }).items.flatMap(batch => batch.events);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map(row => row.contract_address + ':' + row.transaction_hash + ':' + row.log_index)))
      .toEqual(new Set(events.map(event => event.contractAddress + ':' + event.transactionHash + ':' + event.logIndex)));
    expect(rows.every(row => row.snapshot_id === snapshot.snapshotId && row.chain_id === '56'
      && row.coverage_from_block === snapshot.finance.coverage.fromBlock
      && row.coverage_to_block === snapshot.finance.coverage.toBlock
      && row.observed_at === snapshot.finance.coverage.observedAt)).toBe(true);
    expect(readCsv(data.exportMetricsCsv({ domain: 'finance', routeId: U }))).toHaveLength(2);
    const emptyContract = snapshot.finance.contracts.find(contract => contract.routeId === U && contract.role === 'redeem')!.address;
    expect(readCsv(data.exportMetricsCsv({ domain: 'finance', routeId: U, contractAddress: emptyContract }))).toEqual([]);
    const contract = events[0]!.contractAddress;
    expect(readCsv(data.exportMetricsCsv({ contractAddress: contract })).every(row => row.contract_address === contract)).toBe(true);
  });

  it('keeps network exports scoped and reconciles request, report and withdrawal events', () => {
    const rows = readCsv(repository().exportMetricsCsv({ domain: 'network' }));
    expect(rows).toHaveLength(223);
    expect(rows.filter(row => row.event === 'SubmitTask')).toHaveLength(116);
    expect(rows.filter(row => row.event === 'ReportResult')).toHaveLength(90);
    expect(rows.filter(row => row.event === 'WithdrawBalance')).toHaveLength(17);
    expect(rows.filter(row => row.event === 'WithdrawBalance').every(row => row.task_id === '')).toBe(true);
    expectError(() => repository().exportMetricsCsv({ domain: 'network', routeId: USDT }), 'INVALID_FILTER', 400);
    expectError(() => repository().exportMetricsCsv({ routeId: U,
      contractAddress: snapshot.finance.events[0]!.contractAddress }), 'UNSUPPORTED_SCOPE', 422);
  });

  it('escapes spreadsheet formulas, quotes and embedded CSV delimiters', () => {
    expect(sanitizeCsvCell('=1+1')).toBe('"\'=1+1"');
    expect(sanitizeCsvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(sanitizeCsvCell('  =1+1')).toBe('"\'  =1+1"');
    expect(sanitizeCsvCell('\n=1+1')).toBe('"\'\n=1+1"');
    expect(sanitizeCsvCell('hello,"world"')).toBe('"hello,""world"""');
    expect(sanitizeCsvCell(null)).toBe('""');
  });
});

describe('explicit snapshot import boundary', () => {
  it('does not expose source ledgers, checkpoint paths, environment IDs or private payloads', () => {
    const path = mkdtempSync(join(tmpdir(), 'primusscope-data-test-'));
    temporary.push(path);
    const files = [
      'docs/discovery/bsc-rpc-observation.json', 'docs/discovery/bsc-native-observation.json',
      'docs/discovery/bsc-window-observation.json', 'docs/discovery/network-free-rpc-observation.json',
      'scripts/discovery/sources/bsc-finance-source.json',
      'docs/discovery/calendar-block-times.json',
    ];
    const excluded = 'excluded-sensitive-source-marker';
    for (const file of files) {
      const value = JSON.parse(readFileSync(join(root, file), 'utf8'));
      value.requestLedger = [{ payload: excluded }];
      value.checkpointPath = excluded;
      value.environmentId = excluded;
      value.decryptedBalance = excluded;
      value.apiKey = excluded;
      if (Array.isArray(value.events)) value.events.forEach((event: Record<string, unknown>) => {
        event.privatePayload = excluded;
      });
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), JSON.stringify(value));
    }
    const imported = buildObservationSet(path, clock());
    expect(imported.snapshotId).toBe(snapshot.snapshotId);
    expect(JSON.stringify(imported)).not.toContain(excluded);
    expect(imported.finance.events).toHaveLength(9);
    expect(imported.network.events).toHaveLength(223);
  });

  it('serves independent validated copies of the build artifact', async () => {
    const first = await getObservationSet();
    first.finance.events.splice(0);
    expect((await getObservationSet()).finance.events).toHaveLength(9);
  });

  it('fails import rather than serving finance events from mismatched block windows', () => {
    const path = mkdtempSync(join(tmpdir(), 'primusscope-window-test-'));
    temporary.push(path);
    const files = [
      'docs/discovery/bsc-rpc-observation.json', 'docs/discovery/bsc-native-observation.json',
      'docs/discovery/bsc-window-observation.json', 'docs/discovery/network-free-rpc-observation.json',
      'scripts/discovery/sources/bsc-finance-source.json',
      'docs/discovery/calendar-block-times.json',
    ];
    for (const file of files) {
      const value = JSON.parse(readFileSync(join(root, file), 'utf8'));
      if (file.endsWith('bsc-window-observation.json')) value.range.toBlock += 1;
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), JSON.stringify(value));
    }
    expect(() => buildObservationSet(path, clock())).toThrow('FINANCE_SCOPE_MISMATCH');
  });
});
