import { expect, test } from '@playwright/test';
import { absentTaskId, financeRouteIds, knownTask, knownTransaction } from './fixtures';
import { parseCsv } from './csv';

test('hosted reads expose scoped data and distinguish unavailable values from zero', async ({ request }) => {
  const response = await request.get('/api/v1/overview'); expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['x-primusscope-data-mode']).toBe('indexed-observations');
  const body = await response.json();
  expect(body.mode).toBe('indexed_observations'); expect(body.snapshotId).toMatch(/^[a-f0-9]{64}$/);
  expect(body.finance.chainId).toBe(56); expect(body.network.chainId).toBe(8453);
  expect(body.finance.eventCount).toBeGreaterThanOrEqual(9);
  expect(body.network.requestCount).toBeGreaterThanOrEqual(116);
  expect(body.network.reportEventCount).toBeGreaterThanOrEqual(90);
  expect(body.network.totalEvents).toBe(body.network.requestCount + body.network.reportEventCount + body.network.withdrawalEventCount);
  expect(body.finance.apy).toBeNull(); expect(body.finance.tvl).toBeNull();
  expect(body.network.successRate).toBeNull(); expect(body.network.verifiedProofCount).toBeNull();
  for (const domain of ['finance','network']) {
    expect(BigInt(body[domain].coverage.toBlock)).toBeGreaterThan(BigInt(body[domain].coverage.fromBlock));
    expect(Number.isFinite(Date.parse(body[domain].coverage.observedAt))).toBe(true);
  }
  expect(JSON.stringify(body)).not.toMatch(/WEB_DATABASE_URL|WORKER_DATABASE_URL|CRON_SECRET|privateKey|decryptedBalance/);
});

test('database status records scheduled attempts and reproducible head lag without runtime credentials', async ({ request }) => {
  const response = await request.get('/api/v1/status/indexer'); expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ storage:'hosted_postgres', publication:'available', collectionMode:'scheduled', intervalMinutes:15 });
  expect(body.domains).toHaveLength(2);
  for (const domain of body.domains) {
    expect(BigInt(domain.nextBlock)).toBe(BigInt(domain.toBlock)+1n);
    expect(domain.lastAttemptAt).not.toBeNull();
    expect(domain.targetFinalizedBlock).not.toBeNull();
    expect(BigInt(domain.lagBlocks)).toBe(BigInt(domain.targetFinalizedBlock) > BigInt(domain.toBlock)
      ? BigInt(domain.targetFinalizedBlock) - BigInt(domain.toBlock) : 0n);
  }
  expect(JSON.stringify(body)).not.toMatch(/postgres(?:ql)?:\/\/|neon\.tech|leaseToken|CRON_SECRET/);
});

test('task evidence and typed lookup retain native-state and verification boundaries', async ({ request }) => {
  const response = await request.get(`/api/v1/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${knownTask.taskId}`);
  expect(response.status()).toBe(200); const task = await response.json();
  expect(task.requestObserved).toBe(true); expect(task.reportEventCount).toBeGreaterThanOrEqual(1);
  expect(task.nativeState.name).toBe('SUCCESS'); expect(task.cryptographicVerification).toBe('not_run');
  const found = await request.post('/api/v1/explore/lookup', { data: { type:'transaction', identifier:knownTransaction, chainId:8453 } });
  expect(found.status()).toBe(200); expect((await found.json()).matches.length).toBeGreaterThan(0);
  const absent = await request.get(`/api/v1/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${absentTaskId}`);
  expect(absent.status()).toBe(404); expect((await absent.json()).code).toBe('NOT_FOUND_IN_COVERAGE');
  const invalid = await request.post('/api/v1/explore/lookup', { data: { type:'task', identifier:'https://private.invalid/key' } });
  expect(invalid.status()).toBe(400); expect(await invalid.text()).not.toContain('private.invalid');
});

test('Finance CSV preserves filtered JSON event identities and source provenance', async ({ request }) => {
  const routeId = financeRouteIds[1];
  const batches = await (await request.get(`/api/v1/finance/vaults/${routeId}/batches`, { params: { limit:'100' } })).json();
  expect(batches.nextCursor).toBeNull();
  const expected = batches.items.flatMap((batch: { events:{ transactionHash:string; logIndex:string }[] }) =>
    batch.events.map(event => `${event.transactionHash}:${event.logIndex}`)).sort();
  const response = await request.get('/api/v1/exports/metrics.csv', { params: { domain:'finance', routeId } });
  expect(response.status()).toBe(200); const [header, ...rows] = parseCsv(await response.text());
  const column = (name:string) => { const index=header.indexOf(name); expect(index).toBeGreaterThanOrEqual(0); return index; };
  expect(rows.length).toBeGreaterThanOrEqual(7);
  expect(rows.map(row => `${row[column('transaction_hash')]}:${row[column('log_index')]}`).sort()).toEqual(expected);
  for (const row of rows) {
    expect(row[column('data_mode')]).toBe('indexed_observations');
    expect(row[column('snapshot_id')]).toBe(batches.snapshotId);
    expect(row[column('chain_id')]).toBe('56'); expect(row[column('source_url')]).toMatch(/^https:\/\//);
  }
});
