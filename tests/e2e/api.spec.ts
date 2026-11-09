import { expect, test, type APIResponse } from "@playwright/test";
import { absentTaskId, financeRouteIds, knownTask, knownTransaction } from "./fixtures";
import { parseCsv } from "./csv";

function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysIn(child)]);
  }
  return [];
}

test("overview returns separate source-backed counts and unavailable values", async ({ request }) => {
  const response = await request.get("/api/v1/overview");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  const body = await response.json();
  expect(body.mode).toBe("recorded_observations");
  expect(body.snapshotId).toMatch(/^[a-f0-9]{64}$/);
  expect(body.finance.chainId).toBe(56);
  expect(body.finance.eventCount).toBe(9);
  expect(body.finance.batchCount).toBe(4);
  expect(body.finance.finalizedBatchCount).toBe(2);
  expect(body.finance.apy).toBeNull();
  expect(body.finance.tvl).toBeNull();
  expect(body.network.chainId).toBe(8453);
  expect(body.network.requestCount).toBe(116);
  expect(body.network.reportEventCount).toBe(90);
  expect(body.network.withdrawalEventCount).toBe(17);
  expect(body.network.totalEvents).toBe(223);
  expect(body.network.successRate).toBeNull();
  expect(body.network.verifiedProofCount).toBeNull();
  expect(body.finance.coverage.contractAddresses).toHaveLength(4);
  expect(BigInt(body.finance.coverage.toBlock)).toBeGreaterThan(BigInt(body.finance.coverage.fromBlock));
  expect(body.finance.coverage.observedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(body.network.coverage.observedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(response.headers()["set-cookie"]).toBeUndefined();

  const keys = keysIn(body);
  for (const forbidden of [
    "ETHERSCAN_API_KEY", "requestLedger", "checkpointPath", "taskResults",
    "exchangeRate", "decryptedBalance", "privateKey", "permit", "sessionPermit",
  ]) {
    expect(keys).not.toContain(forbidden);
  }
});

test("finance directory and source status share the same recorded snapshot", async ({ request }) => {
  const overview = await (await request.get("/api/v1/overview")).json();
  const response = await request.get("/api/v1/finance/vaults");
  expect(response.status()).toBe(200);
  const directory = await response.json();
  expect(directory.snapshotId).toBe(overview.snapshotId);
  expect(directory.mode).toBe("recorded_observations");
  expect(directory.items.map((item: { id: string }) => item.id).sort()).toEqual([...financeRouteIds].sort());
  for (const item of directory.items) {
    expect(item.chainId).toBe(56);
    expect(item.apy).toBeNull();
    expect(item.totalAssets).toBeNull();
  }

  const statusResponse = await request.get("/api/v1/status/sources");
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  expect(status.snapshotId).toBe(overview.snapshotId);
  expect(status.items.length).toBeGreaterThan(0);
});

test("known task retains contract identity and separates native success from proof checks", async ({ request }) => {
  const response = await request.get(
    `/api/v1/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${knownTask.taskId}`,
  );
  expect(response.status()).toBe(200);
  const task = await response.json();
  expect(task.chainId).toBe(8453);
  expect(task.contractAddress.toLowerCase()).toBe(knownTask.contractAddress);
  expect(task.taskId).toBe(knownTask.taskId);
  expect(task.requestObserved).toBe(true);
  expect(task.reportEventCount).toBeGreaterThanOrEqual(1);
  expect(task.nativeState.name).toBe("SUCCESS");
  expect(task.cryptographicVerification).toBe("not_run");
  expect(task.events.some((event: { kind: string }) => event.kind === "SubmitTask")).toBe(true);
  expect(task.events.some((event: { kind: string }) => event.kind === "ReportResult")).toBe(true);
});

test("unknown task is absent within covered observations, not an invalid proof", async ({ request }) => {
  const response = await request.get(
    `/api/v1/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${absentTaskId}`,
  );
  expect(response.status()).toBe(404);
  const error = await response.json();
  expect(error.code).toBe("NOT_FOUND_IN_COVERAGE");
  expect(error.message.toLowerCase()).not.toContain("invalid proof");
});

test("typed lookup resolves a recorded transaction without an external RPC proxy", async ({ request }) => {
  const response = await request.post("/api/v1/explore/lookup", {
    data: { type: "transaction", identifier: knownTransaction, chainId: 8453 },
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.mode).toBe("recorded_observations");
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches.some((match: { href: string }) => match.href.includes(knownTask.taskId))).toBe(true);
});

test("malformed and oversized lookup inputs fail without echoing raw input", async ({ request }) => {
  const secretLookingInput = "https://rpc.invalid/private-secret-value";
  const response = await request.post("/api/v1/explore/lookup", {
    data: { type: "task", identifier: secretLookingInput },
  });
  expect(response.status()).toBe(400);
  expect(await response.text()).not.toContain("private-secret-value");

  const oversized = await request.post("/api/v1/explore/lookup", {
    data: { type: "task", identifier: "a".repeat(4096) },
  });
  expect(oversized.status()).toBe(413);
});

test("batch pagination binds the cursor and returns every scoped record once", async ({ request }) => {
  const path = `/api/v1/finance/vaults/${financeRouteIds[1]}/batches`;
  const allResponse = await request.get(path);
  expect(allResponse.status()).toBe(200);
  const all = await allResponse.json();
  const identities: string[] = [];
  let cursor: string | null = null;
  let firstCursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const response: APIResponse = await request.get(path, { params: { limit: "1", ...(cursor ? { cursor } : {}) } });
    expect(response.status()).toBe(200);
    const body: {
      items: { contractAddress: string; batchId: string }[];
      total: number;
      nextCursor: string | null;
    } = await response.json();
    expect(body.items.length).toBeLessThanOrEqual(1);
    expect(body.total).toBe(all.total);
    identities.push(...body.items.map((item: { contractAddress: string; batchId: string }) => `${item.contractAddress}:${item.batchId}`));
    cursor = body.nextCursor;
    firstCursor ||= cursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(identities).toHaveLength(all.total);
  expect(new Set(identities).size).toBe(identities.length);

  expect(firstCursor).not.toBeNull();
  const changedScope = await request.get(`/api/v1/finance/vaults/${financeRouteIds[0]}/batches`, {
    params: { limit: "1", cursor: firstCursor! },
  });
  expect([400, 409]).toContain(changedScope.status());
});

test("finance CSV reconciles to the same filtered event identities and provenance", async ({ request }) => {
  const routeId = financeRouteIds[1];
  const batches = await (await request.get(`/api/v1/finance/vaults/${routeId}/batches`)).json();
  const expected = batches.items.flatMap((batch: { events: { transactionHash: string; logIndex: string }[] }) =>
    batch.events.map((event) => `${event.transactionHash}:${event.logIndex}`),
  ).sort();
  const response = await request.get("/api/v1/exports/metrics.csv", { params: { domain: "finance", routeId } });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  const [header, ...rows] = parseCsv(await response.text());
  const column = (name: string) => {
    const index = header.indexOf(name);
    expect(index, `missing CSV header ${name}`).toBeGreaterThanOrEqual(0);
    return index;
  };
  expect(rows).toHaveLength(7);
  expect(rows.map((row) => `${row[column("transaction_hash")]}:${row[column("log_index")]}`).sort()).toEqual(expected);
  for (const row of rows) {
    expect(row).toHaveLength(header.length);
    expect(row[column("domain")]).toBe("finance");
    expect(row[column("chain_id")]).toBe("56");
    expect(row[column("snapshot_id")]).toBe(batches.snapshotId);
    expect(row[column("source_url")]).toMatch(/^https:\/\//);
    expect(Number.isFinite(Date.parse(row[column("observed_at")]))).toBe(true);
  }

  const unitedStables = await request.get("/api/v1/exports/metrics.csv", {
    params: { domain: "finance", routeId: financeRouteIds[0] },
  });
  expect(unitedStables.status()).toBe(200);
  expect(parseCsv(await unitedStables.text())).toHaveLength(3);

  const empty = await request.get("/api/v1/exports/metrics.csv", {
    params: {
      domain: "finance",
      routeId: financeRouteIds[0],
      contractAddress: "0xbef1366512ffff33cdd6c48d66e48d33c6dbca22",
    },
  });
  expect(empty.status()).toBe(200);
  expect(parseCsv(await empty.text())).toHaveLength(1);
});
