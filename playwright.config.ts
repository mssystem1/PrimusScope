import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const indexed = process.env.E2E_DATA_MODE === "indexed";
const hosted = process.env.E2E_DATA_MODE === "hosted";
const externalBaseUrl = process.env.E2E_BASE_URL;
if (hosted && !externalBaseUrl) throw new Error('Hosted validation requires E2E_BASE_URL.');
if (indexed && externalBaseUrl) {
  throw new Error("Indexed fixture tests use their isolated local database and server; unset E2E_BASE_URL.");
}
const baseURL = indexed ? "http://127.0.0.1:3001" : externalBaseUrl || "http://127.0.0.1:3000";
const artifacts = indexed ? ".local/test-results-indexed" : hosted ? ".local/test-results-hosted" : ".local/test-results";
function externalProxy() {
  if (!externalBaseUrl) return undefined;
  const value = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!value) return undefined;
  const url = new URL(value);
  // Playwright serializes configuration into reports. Credential-bearing proxy
  // URLs must never be copied there; managed cloud uses a local proxy bridge.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('External browser tests require a credential-free runtime proxy bridge.');
  }
  return { server: url.origin, bypass: process.env.NO_PROXY || process.env.no_proxy };
}
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (process.env.CI ? undefined : "/usr/bin/chromium");
const chromium = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1440, height: 1000 },
  launchOptions: {
    executablePath,
  },
};
const indexedDbPath = process.env.PRIMUSSCOPE_E2E_DB_PATH || resolve(
  ".local/e2e-indexed", `observations-${process.pid}-${Date.now()}.sqlite`,
);
if (indexed) process.env.PRIMUSSCOPE_E2E_DB_PATH = indexedDbPath;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: artifacts,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: indexed ? 0 : process.env.CI ? 1 : 0,
  workers: indexed ? 1 : 2,
  reporter: [
    ["list"],
    ["json", { outputFile: `${artifacts}/results.json` }],
    ["html", { outputFolder: indexed ? ".local/playwright-report-indexed" : hosted ? ".local/playwright-report-hosted" : ".local/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    proxy: externalProxy(),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: indexed ? [
    { name: "indexed-chromium", testMatch: "indexed.spec.ts", use: chromium },
  ] : [
    { name: "api", testMatch: hosted ? ["hosted-api.spec.ts","sdk-hosted.spec.ts"] : "api.spec.ts" },
    {
      name: "chromium",
      testMatch: ["app.spec.ts", "activity.spec.ts", "dashboards.spec.ts", "hydration.spec.ts", "sdk-tools.spec.ts", "daily-use.spec.ts"],
      use: chromium,
    },
    ...[360, 390].map((width) => ({
      name: `mobile-${width}`,
      testMatch: ["mobile.spec.ts", "activity.spec.ts", "dashboards.spec.ts", "hydration.spec.ts", "sdk-tools.spec.ts", "daily-use.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        launchOptions: {
          executablePath,
        },
      },
    })),
  ],
  webServer: indexed ? {
    command: "node --import tsx tests/e2e/indexed/start-server.ts",
    url: baseURL,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 120_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      PRIMUSSCOPE_DATA_MODE: "indexed",
      PRIMUSSCOPE_DB_PATH: indexedDbPath,
      PRIMUSSCOPE_E2E_DB_PATH: indexedDbPath,
    },
  } : externalBaseUrl
    ? undefined
    : {
        command:
          "npm run start --workspace @primusscope/web -- --hostname 127.0.0.1 --port 3000",
        url: baseURL,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
        timeout: 120_000,
        env: { NEXT_TELEMETRY_DISABLED: "1", PRIMUSSCOPE_DATA_MODE: "recorded" },
      },
});
