import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { financeRouteIds, knownFinanceBatchPath, knownTask, knownTaskPath } from "./fixtures";
import { fixtureAction, fixtureDatabasePath } from "./indexed/paths";
import { parseCsv } from "./csv";

type Overview = {
  mode: string;
  snapshotId: string;
  finance: {
    eventCount: number;
    apy: unknown;
    tvl: unknown;
    coverage: { toBlock: string; observedAt: string };
    freshness: { state: string };
  };
  network: { requestCount: number; reportEventCount: number; verifiedProofCount: unknown };
};

type Status = {
  mode: string;
  storage: string;
  publication: string;
  snapshotId: string;
  continuousWorker: boolean;
  domains: {
    domain: string;
    toBlock: string;
    observedAt: string;
    lastOutcome: string | null;
    lastErrorCode: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    targetFinalizedBlock: string | null;
    lagBlocks: string | null;
  }[];
};

async function overview(request: APIRequestContext): Promise<Overview> {
  const response = await request.get("/api/v1/overview");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-primusscope-data-mode"]).toBe("indexed-observations");
  return response.json();
}

async function status(request: APIRequestContext): Promise<Status> {
  const response = await request.get("/api/v1/status/indexer");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toContain(fixtureDatabasePath());
  return body;
}

test.describe("isolated persistent indexed read model", () => {
  test.describe.configure({ mode: "serial" });

  test("a restarted reader serves the sanitized seed with explicit local indexing scope", async ({ request }) => {
    const body = await overview(request);
    expect(body.mode).toBe("indexed_observations");
    expect(body.finance.eventCount).toBe(9);
    expect(body.network.requestCount).toBe(116);
    expect(body.network.reportEventCount).toBe(90);
    expect(body.finance.apy).toBeNull();
    expect(body.finance.tvl).toBeNull();
    expect(body.network.verifiedProofCount).toBeNull();
    const indexer = await status(request);
    expect(indexer.mode).toBe("indexed_observations");
    expect(indexer.storage).toBe("local_sqlite");
    expect(indexer.publication).toBe("available");
    expect(indexer.snapshotId).toBe(body.snapshotId);
    expect(indexer.continuousWorker).toBe(false);
    expect(indexer.domains.map((domain) => domain.domain).sort()).toEqual(["finance", "network"]);
    const sources = await (await request.get("/api/v1/status/sources")).json();
    expect(sources.mode).toBe("indexed_observations");
    expect(sources.snapshotId).toBe(body.snapshotId);
  });

  test("a separate writer advances an empty block range without rebuilding and expires old cursors", async ({ request }) => {
    const before = await overview(request);
    const path = `/api/v1/finance/vaults/${financeRouteIds[1]}/batches`;
    const first = await (await request.get(path, { params: { limit: "1" } })).json();
    expect(first.nextCursor).toEqual(expect.any(String));
    const watchItems={items:[{id:'indexed-task-watch',href:knownTaskPath}]};
    const watchBefore=await(await request.post('/api/v1/workspace/check',{data:watchItems})).json();

    await fixtureAction("advance");
    await expect.poll(async () => (await overview(request)).snapshotId).not.toBe(before.snapshotId);
    const after = await overview(request);
    expect(after.finance.coverage.toBlock).toBe((BigInt(before.finance.coverage.toBlock) + 1n).toString());
    expect(after.finance.eventCount).toBe(before.finance.eventCount);
    expect(after.network.requestCount).toBe(before.network.requestCount);
    const watchAfter=await(await request.post('/api/v1/workspace/check',{data:watchItems})).json();
    expect(watchAfter.snapshotId).not.toBe(watchBefore.snapshotId);
    expect(watchAfter.items[0].scopeKey).toBe(watchBefore.items[0].scopeKey);
    expect(watchAfter.items[0].contentHash).toBe(watchBefore.items[0].contentHash);
    expect(after.network.reportEventCount).toBe(before.network.reportEventCount);
    expect(await fixtureAction("repeat")).toMatchObject({
      idempotent: true, insertedEvents: 0, snapshotId: after.snapshotId, eventCount: 9,
    });
    const afterReplay = await overview(request);
    expect(afterReplay.snapshotId).toBe(after.snapshotId);
    expect(afterReplay.finance.coverage).toEqual(after.finance.coverage);
    const expired = await request.get(path, { params: { limit: "1", cursor: first.nextCursor } });
    expect(expired.status()).toBe(409);
    expect((await expired.json()).code).toBe("SNAPSHOT_EXPIRED");
    const freshPage = await (await request.get(path, { params: { limit: "1" } })).json();
    expect(freshPage.snapshotId).toBe(after.snapshotId);
    expect(freshPage.total).toBe(3);
    const exported = await request.get("/api/v1/exports/metrics.csv", {
      params: { domain: "finance", routeId: financeRouteIds[1] },
    });
    expect(exported.status()).toBe(200);
    expect(exported.headers()["x-primusscope-data-mode"]).toBe("indexed-observations");
    const [header, ...rows] = parseCsv(await exported.text());
    const snapshotColumn = header.indexOf("snapshot_id");
    const coverageColumn = header.indexOf("coverage_to_block");
    expect(snapshotColumn).toBeGreaterThanOrEqual(0);
    expect(coverageColumn).toBeGreaterThanOrEqual(0);
    expect(rows).toHaveLength(7);
    expect([...new Set(rows.map((row) => row[snapshotColumn]))]).toEqual([after.snapshotId]);
    expect([...new Set(rows.map((row) => row[coverageColumn]))]).toEqual([after.finance.coverage.toBlock]);
  });

  test("a failed restarted writer preserves trusted coverage and reports stale data and backlog", async ({ request }) => {
    const before = await overview(request);
    await fixtureAction("fail");
    const indexer = await status(request);
    const finance = indexer.domains.find((domain) => domain.domain === "finance")!;
    expect(finance.lastOutcome).toBe("failed");
    expect(finance.lastErrorCode).toBe("RPC_TIMEOUT");
    expect(finance.toBlock).toBe(before.finance.coverage.toBlock);
    expect(finance.observedAt).toBe(before.finance.coverage.observedAt);
    expect(finance.targetFinalizedBlock).not.toBeNull();
    expect(BigInt(finance.lagBlocks!)).toBeGreaterThan(0n);
    const after = await overview(request);
    expect(after.finance.coverage).toEqual(before.finance.coverage);
    expect(after.finance.eventCount).toBe(9);
    expect(after.network.requestCount).toBe(116);
    expect(after.finance.freshness.state).toBe("stale");
    expect(indexer.publication).toBe("available");
    expect(indexer.continuousWorker).toBe(false);
  });

  test("indexed source and failure disclosure remain accessible on desktop and mobile", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto("/sources");
    await expect(page.getByText("Indexed observations", { exact: true }).first()).toBeVisible();
    const indexer = page.getByRole("region", { name: "Indexer status", exact: true });
    await expect(indexer).toBeVisible();
    const finance = page.getByRole("region", { name: "Finance indexer status", exact: true });
    await expect(finance.getByText("Last attempt failed", { exact: true })).toBeVisible();
    await expect(finance.getByText(/the failed range did not advance coverage/i)).toBeVisible();
    await expect(finance.getByText("RPC_TIMEOUT", { exact: true })).toBeVisible();
    await expect(finance.getByText("Blocks behind that head", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh view from stored observations", exact: true })).toBeVisible();

    for (const width of [1440, 360, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      for (const path of ["/", "/sources", knownTaskPath, knownFinanceBatchPath]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByText("Indexed observations", { exact: true }).first()).toBeVisible();
        const dimensions = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
        }));
        expect(dimensions.content, `${path} at ${width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
      }
      await page.goto("/sources");
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), `Sources at ${width}px`).toEqual([]);
      await testInfo.attach(`indexed-sources-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });

  test("a successful restarted writer recovers and the source view refreshes stored data", async ({ page, request }) => {
    await page.goto("/sources");
    const finance = page.getByRole("region", { name: "Finance indexer status", exact: true });
    await expect(finance.getByText("Last attempt failed", { exact: true })).toBeVisible();
    const before = await overview(request);
    await fixtureAction("recover");
    await expect.poll(async () => (await overview(request)).snapshotId).not.toBe(before.snapshotId);
    const after = await overview(request);
    expect(after.finance.coverage.toBlock).toBe((BigInt(before.finance.coverage.toBlock) + 1n).toString());
    expect(after.finance.eventCount).toBe(9);
    const recovered = (await status(request)).domains.find((domain) => domain.domain === "finance")!;
    expect(recovered.lastOutcome).toBe("advanced");
    expect(recovered.lastErrorCode).toBeNull();
    expect(recovered.lastSuccessAt).not.toBeNull();
    await page.getByRole("button", { name: "Refresh view from stored observations", exact: true }).click();
    await expect(finance.getByText("Last attempt failed", { exact: true })).toHaveCount(0);
    const taskResponse = await request.get(`/api/v1/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${knownTask.taskId}`);
    expect(taskResponse.status()).toBe(200);
    expect((await taskResponse.json()).cryptographicVerification).toBe("not_run");
  });
});
