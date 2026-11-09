import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { knownFinanceBatchPath, knownTaskPath } from "./fixtures";

test("mobile navigation exposes the real public modules", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ecosystem overview", exact: true })).toBeVisible();
  const openMenu = page.getByRole("button", { name: "Open navigation", exact: true });
  await openMenu.click();
  const drawer = page.getByRole("dialog", { name: "Navigation menu", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(openMenu).toBeFocused();
  await openMenu.click();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav).toBeVisible();
  await nav.locator('a[href="/finance"]').click();
  await expect(page.getByRole("heading", { name: "Confidential Finance", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
});

test("public screens reflow without page-wide horizontal overflow", async ({ page }, testInfo) => {
  for (const path of ["/", "/finance", "/network", "/explore", "/workspace", "/developers", "/sources", knownTaskPath, knownFinanceBatchPath]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, `${path} at ${dimensions.viewport}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
    await expect(page.getByRole("button", { name: /^connect wallet$/i })).toHaveCount(0);
  }
  await page.goto("/finance");
  await testInfo.attach(`finance-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("mobile overview, navigation drawer, and task evidence pass automated WCAG checks", async ({ page }) => {
  test.setTimeout(60_000);
  async function check(label: string) {
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const violations = result.violations.map(({ id, impact, nodes }) => ({
      id, impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }));
    expect(violations, `Mobile accessibility scan: ${label}`).toEqual([]);
  }
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await check("overview");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation menu", exact: true });
  await expect(drawer.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
  await check("navigation drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.goto(knownTaskPath);
  await expect(page.getByRole("heading", { name: "Task evidence", exact: true })).toBeVisible();
  await check("task evidence");
});
