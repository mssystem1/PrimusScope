import { expect, test, type Page } from '@playwright/test';

async function holdAnalyticsResponse(page: Page, path: string, range: string) {
  const match = (url: URL) => url.pathname === path && url.searchParams.get('range') === range;
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(match, async route => {
    if (route.request().headers().rsc === '1') {
      requested = true;
      await gate;
    }
    await route.continue();
  });
  return {
    requested: () => requested,
    release,
    async close() {
      release();
      await page.unroute(match);
    },
  };
}

test('comparison navigation shows progress while keeping the previous dashboard visible', async ({ page }) => {
  const response = await holdAnalyticsResponse(page, '/finance', '30d');
  const progress = page.getByRole('progressbar', { name: 'Updating analytics' });
  const comparison = page.getByRole('region', { name: 'Shared strategy · period comparison' });
  try {
    await page.goto('/finance?range=all&interval=hour');
    await expect(page.getByLabel('Period', { exact: true })).toBeEnabled();
    const originalUrl = page.url();
    const compare30 = comparison.getByRole('link', { name: 'Compare 30 days', exact: true });
    await page.evaluate(() => { document.documentElement.dataset.analyticsNavigationTest = 'retained'; });

    const modifierKeptNativeBehavior = await compare30.evaluate(link => {
      let prevented: boolean | undefined;
      window.addEventListener('click', event => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      }, { once: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      return prevented === false;
    });
    expect(modifierKeptNativeBehavior).toBe(true);
    await expect(page).toHaveURL(originalUrl);
    await expect(progress).toHaveCount(0);

    await page.clock.install();
    await compare30.click();
    await expect(progress).toBeVisible();
    await expect.poll(response.requested).toBe(true);
    await expect(page).toHaveURL(originalUrl);
    await expect(comparison.getByText(/All available history has no equivalent preceding window/)).toBeVisible();
    await page.clock.fastForward(10_001);
    await expect(page.getByRole('status').filter({hasText:'Still loading 30 days'})).toBeVisible();
    response.release();

    const selectedUrl = /\/finance\?range=30d&interval=hour$/;
    await expect(page).toHaveURL(selectedUrl);
    await expect(comparison.getByText(/^Last 30 days ·/)).toBeVisible();
    await expect(comparison.getByText(/^Prior 30 days ·/)).toBeVisible();
    await expect(progress).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-analytics-navigation-test', 'retained');
    await expect(compare30).toHaveAttribute('aria-current', 'page');
    await compare30.click();
    await expect(progress).toHaveCount(0);
    await expect(page).toHaveURL(selectedUrl);
  } finally {
    await response.close();
  }
});

test('the dashboard period form shows progress until the updated dashboard is ready', async ({ page }) => {
  const response = await holdAnalyticsResponse(page, '/finance', '7d');
  const form = page.getByRole('form', { name: 'Analytics period' });
  const period = form.getByLabel('Period', { exact: true });
  const progress = page.getByRole('progressbar', { name: 'Updating analytics' });
  try {
    await page.goto('/finance?range=all&interval=day');
    await expect(period).toBeEnabled();
    const originalUrl = page.url();
    await period.selectOption('7d');
    await form.getByRole('button', { name: 'Update dashboard', exact: true }).click();
    await expect(progress).toBeVisible();
    await expect.poll(response.requested).toBe(true);
    await expect(page).toHaveURL(originalUrl);
    await expect(form.getByRole('button', { name: 'Updating dashboard…', exact: true })).toBeDisabled();
    response.release();

    await expect(page).toHaveURL(/\/finance\?range=7d&interval=day$/);
    await expect(period).toHaveValue('7d');
    await expect(progress).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Update dashboard', exact: true })).toBeEnabled();
  } finally {
    await response.close();
  }
});
