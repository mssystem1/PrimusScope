import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { absentTaskId, financeRouteIds, knownTask, knownTaskPath } from "./fixtures";

test("anonymous public pages show honest recorded scope and usable navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ecosystem overview", exact: true })).toBeVisible();
  await expect(page.getByText("Recorded observations", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^connect wallet$/i })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await testInfo.attach("overview-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  for (const [path, heading] of [
    ["/finance", "Confidential Finance"],
    ["/network", "zkTLS Network"],
    ["/explore", "Task & Proof Explorer"],
    ["/developers", "Developer tools"],
    ["/sources", "Sources & coverage"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("Recorded observations", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^connect wallet$/i })).toHaveCount(0);
  }
});

test("known task lookup reaches its contract-scoped evidence page", async ({ page }) => {
  await page.goto("/explore");
  await page.getByLabel("Task ID, transaction hash, or contract address").fill(knownTask.taskId);
  await page.getByRole("button", { name: "Search observations", exact: true }).click();
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toBeVisible();
  const taskLink = results.locator(`a[href="${knownTaskPath}"]`).first();
  await expect(taskLink).toBeVisible();
  await taskLink.click();
  await expect(page).toHaveURL(new RegExp(`${knownTask.taskId}$`));
  await expect(page.getByText(knownTask.taskId, { exact: true })).toBeVisible();
  await expect(page.getByText(/^success$/i).first()).toBeVisible();
  await expect(page.getByText(/not (?:checked|run|performed)|unverified/i).first()).toBeVisible();
});

test("unknown task lookup explains absence in the recorded scope", async ({ page }) => {
  await page.goto("/explore");
  await page.getByLabel("Task ID, transaction hash, or contract address").fill(absentTaskId);
  await page.getByRole("button", { name: "Search observations", exact: true }).click();
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByText(/no match|not found/i).first()).toBeVisible();
  await expect(results.getByText(/scope|coverage|recorded/i).first()).toBeVisible();
  await expect(results.getByText(/invalid proof/i)).toHaveCount(0);
});

test("missing and unsupported task routes return a coverage-aware 404", async ({ page }) => {
  for (const path of [
    `/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${absentTaskId}`,
    `/network/tasks/56/${knownTask.contractAddress}/${knownTask.taskId}`,
  ]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "No record in this coverage", exact: true })).toBeVisible();
    await expect(page.getByText(/It may exist outside the sampled contracts or block ranges/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Inspect source coverage", exact: true })).toHaveAttribute("href", "/sources");
    await expect(page.getByText(/invalid proof/i)).toHaveCount(0);
  }
});

test("public watchlist persists in this browser and clears without a wallet", async ({ page }) => {
  await page.goto("/finance");
  const save = page.getByRole("button", { name: /^Save / }).first();
  const label = await save.getAttribute("aria-label");
  const text = label || (await save.innerText());
  const savedTitle = text.replace(/^Save\s+/, "");
  await save.click();
  await expect(page.getByRole("button", { name: `Saved ${savedTitle}`, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Your public workspace", exact: true })).toBeVisible();
  await expect(page.getByText(savedTitle, { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(savedTitle, { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Clear saved items", exact: true }).click();
  await page.reload();
  await expect(page.getByText(savedTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^connect wallet$/i })).toHaveCount(0);
});

test("vault analytics opens a contract-scoped public batch and preserves export scope", async ({ page, request }) => {
  const routePath = `/finance/vaults/${financeRouteIds[1]}`;
  const response = await request.get(`/api/v1${routePath}/batches`);
  expect(response.status()).toBe(200);
  const batches = await response.json();
  expect(batches.items).toHaveLength(3);
  const batch = batches.items[0];

  await page.goto("/finance");
  await page.locator(`a[href="${routePath}"]`).first().click();
  await expect(page.getByRole("heading", { name: "USDT / eUSDT vault route", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Export events", exact: true })).toHaveAttribute(
    "href", `/api/v1/exports/metrics.csv?domain=finance&routeId=${financeRouteIds[1]}`,
  );
  const batchPath = `/finance/batches/${batch.contractAddress}/${batch.batchId}`;
  await page.locator(`a[href="${batchPath}"]`).first().click();
  await expect(page.getByRole("heading", { name: `Batch #${batch.batchId}`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Aggregator source", exact: true })).toHaveAttribute(
    "href", `https://bscscan.com/address/${batch.contractAddress}#code`,
  );
  await expect(page.getByRole("heading", { name: "Source-backed batch timeline", exact: true })).toBeVisible();
  for (const event of batch.events) {
    await expect(page.locator(`a[href="https://bscscan.com/tx/${event.transactionHash}"]`).first()).toBeVisible();
  }
  await expect(page.getByText("Batch finalization is not individual claim completion.", { exact: true })).toBeVisible();
});

test("source evidence links are explicit and safe without leaving the application", async ({ page }) => {
  await page.goto("/sources");
  const external = page.locator('main a[href^="https://"]');
  expect(await external.count()).toBeGreaterThan(0);
  const links = await external.evaluateAll((anchors) => anchors.map((anchor) => ({
    href: anchor.getAttribute("href"),
    target: anchor.getAttribute("target"),
    rel: anchor.getAttribute("rel"),
  })));
  for (const link of links) {
    expect(link.href).not.toMatch(/apikey=|token=|secret=/i);
    if (link.target === "_blank") {
      expect(link.rel).toContain("noopener");
      expect(link.rel).toContain("noreferrer");
    }
  }
});

test("chart values reconcile to the API and expose their definition and coverage", async ({ page, request }) => {
  const response = await request.get("/api/v1/network/summary");
  expect(response.status()).toBe(200);
  const network = await response.json();
  await page.goto("/");
  const definition = page.locator("details").filter({
    has: page.getByText("Definition & source", { exact: true }),
  }).first();
  await definition.getByText("Definition & source", { exact: true }).click();
  await expect(definition.getByText("Requests and reports", { exact: true })).toBeVisible();
  await expect(definition.getByText("Base · 8453", { exact: true })).toBeVisible();
  await expect(definition.getByText(/An attestor report is not a completed task/)).toBeVisible();
  await expect(definition.getByRole("link", { name: /Full sources & limitations/ })).toHaveAttribute("href", "/sources");

  await page.getByText("View chart data", { exact: true }).click();
  const table = page.getByRole("table", { name: "Network activity by block interval", exact: true });
  await expect(table).toBeVisible();
  const values = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => {
    const cells = row.querySelectorAll("td");
    return { requests: Number(cells[1]?.textContent), reports: Number(cells[2]?.textContent) };
  }));
  expect(values).toHaveLength(16);
  expect(values.reduce((sum, row) => sum + row.requests, 0)).toBe(network.requestCount);
  expect(values.reduce((sum, row) => sum + row.reports, 0)).toBe(network.reportEventCount);
});

test("developer playground runs the real anonymous snapshot API", async ({ page }) => {
  await page.goto("/developers");
  await page.getByLabel("API endpoint").selectOption("/api/v1/overview");
  await page.getByRole("button", { name: "Run request", exact: true }).click();
  const response = page.getByLabel("API response");
  await expect(response).toContainText('"mode": "recorded_observations"');
  const body = JSON.parse(await response.innerText());
  expect(body.finance.eventCount).toBe(9);
  expect(body.network.requestCount).toBe(116);
  expect(body.network.verifiedProofCount).toBeNull();
  expect(await response.innerText()).not.toContain("ETHERSCAN_API_KEY");
});

test("the lookup workflow works from keyboard navigation", async ({ page }) => {
  await page.goto("/explore");
  const input = page.getByLabel("Task ID, transaction hash, or contract address");
  for (let step = 0; step < 24; step += 1) {
    if (await input.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(input).toBeFocused();
  await page.keyboard.insertText(knownTask.taskId);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Search results" }).locator(`a[href="${knownTaskPath}"]`).first()).toBeVisible();
});

test("critical public screens have no detected WCAG A/AA violations", async ({ page }) => {
  test.setTimeout(90_000);
  for (const path of ["/", "/finance", "/network", "/explore", "/workspace", "/developers", "/sources", knownTaskPath]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const violations = result.violations.map(({ id, impact, nodes }) => ({
      id, impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }));
    expect(violations, `Accessibility scan: ${path}`).toEqual([]);
  }
});
