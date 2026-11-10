# Application verification

The first application release uses a sanitized recorded observation set. The test
fixtures identify actual observed public tasks and Finance routes. They do not
create transactions or call upstream RPC and explorer services.

Run the production build and local application checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The Playwright configuration starts its own production server at
`http://127.0.0.1:3000`. Stop any manual server on that port before running the
suite; reusing a process from an earlier build can serve stale asset references.
The configuration terminates its server after the suite. It uses the system
Chromium at `/usr/bin/chromium`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a
different installed Chromium. No TLS verification bypass is configured.

The suite covers the anonymous public routes, real lookup and detail workflows,
browser-local saved items, the developer API playground, provenance disclosures,
accessible chart data, WCAG A/AA automated checks, and mobile navigation and
reflow at widths of 360 and 390 pixels. API checks reconcile Finance CSV event
identities to JSON, exercise pagination and input boundaries, and distinguish
unavailable financial metrics and unperformed proof verification from zero.

Reports, traces, screenshots, and JSON results are written beneath `.local/` and
are ignored by Git. A passing automated accessibility scan does not establish
complete accessibility or usability. Manual review should also inspect keyboard
focus, reading order, chart comprehension, and mobile task completion.

To test an explicitly selected deployment, set `E2E_BASE_URL` to its HTTPS URL:

```sh
E2E_BASE_URL=https://your-review-deployment.example npm run test:e2e
```

This skips the local web server. Local results do not establish Vercel deployment
readiness; run the suite separately against the actual deployment URL. The
fixture counts intentionally describe the current recorded snapshot, and should
be reviewed if that snapshot changes.

External tests honor the managed cloud's HTTP(S) proxy and `NO_PROXY` settings.
Keep the runtime's supplied Node CA trust. Chromium must be able to use that
existing environment CA in its NSS certificate store. If the filesystem sandbox
prevents browser trust-store access, use the approved outer execution context
for those tests. Neither `ignoreHTTPSErrors` nor certificate-error bypass flags are used. Proxy
URLs containing embedded credentials are rejected to keep them out of reports.

## Local indexed mode

The default command above runs 55 recorded-mode checks. Run the separate
indexed-mode project after building the application:

```sh
E2E_DATA_MODE=indexed npm run test:e2e
```

This project starts a second local production server on port 3001 with
`PRIMUSSCOPE_DATA_MODE=indexed`. Its wrapper creates a unique SQLite database
beneath `.local/e2e-indexed/` and passes that absolute path to the server through
`PRIMUSSCOPE_DB_PATH`. It never uses a configured production database or a live
RPC service. Do not set `E2E_BASE_URL` for this project: its workflow deliberately
mutates its local fixture database while the test server is running.

The fixture combines the sanitized recorded seed with explicitly synthetic
indexer progress and failure metadata. Assertions check durable reads, snapshot
and pagination boundaries, unchanged event counts after an empty block range,
failure/backlog reporting without invented coverage, and honest indexed-mode UI
disclosure. These results demonstrate the local read model and its worker
handoff; they do not establish live-chain indexing or remote database support.

Indexed results are kept separately in `.local/test-results-indexed/` and
`.local/playwright-report-indexed/`, preserving the recorded-mode reports.

## Hosted deployment

After deploying hosted serving, run:

```sh
E2E_DATA_MODE=hosted E2E_BASE_URL=https://primus-scope.vercel.app npm run test:e2e
```

This uses the same desktop/mobile workflows with indexed-mode disclosures and
coverage-aware API assertions, plus actual hosted database status, CSV and SDK
diagnostic checks (52 hosted checks). Public analytics checks are read-only.
The SDK API canary creates two temporary diagnostic projects, records explicitly
marked test metadata, then deletes them in cleanup. No collector credentials
are needed. Live keys and owner cookies are excluded from canary traces and
screenshots; avoid adding raw response bodies to assertion output.
Reports use `.local/test-results-hosted/` and `.local/playwright-report-hosted/`.
The collector must have completed an authorized invocation before this suite:
the status checks require measured attempts and head comparisons.

Unit integration tests execute real PostgreSQL SQL in PGlite for fenced writes,
database role permissions and durable job handoff. Native transport tests cover
response budgets and safe errors; route tests refuse unauthorized work before
database/RPC setup. These local tests supplement actual Neon/Vercel validation.
Build both projects with `npm run build` and `npm run build:collector`.

The Network activity workflows run in each desktop/mobile project. They cover
combined filters, share/copy, saved view restoration (including section anchors),
CSV selection/snapshot consistency, paging, stale-cursor recovery, empty and
uncovered scopes, and accessible chart drill-down. Run them alone with
`npm run test:e2e -- --grep 'event filters|pagination, changed|chart intervals'`.

## Official SDK tools pilot

The pilot's local evidence is 242 tests across 28 files; typecheck and
web build pass. Release-specific HTTPS checks are recorded separately. The inspector and
Developer Studio workflows, privacy boundaries and positive-verification gate
are documented in [SDK_TOOLS.md](SDK_TOOLS.md). No public genuine Primus-signed
fixture matches the pinned SDK signer, so negative-path and synthetic policy
tests do not establish successful positive verification.

The dashboard workflows run on desktop and both phone widths. They check the
primary U/eU and USDT/eUSDT routes, measured strategy charts, legend visibility,
keyboard inspection, downloadable chart CSV, period changes, cohort API/UI
reconciliation, accessible chart tables, WCAG scans and horizontal reflow.
Unit tests separately verify exact raw-unit conversion, actual-elapsed APY, flow
conservation, coverage gaps, report cohort counts, runtime pinning and persistence
across collector jobs. These are source and arithmetic checks, not private
position attribution or independent consensus.

UTC date tests cover real/leap dates, inclusive day ends, invalid/repeated query
parameters, whole and partial coverage, historical stock KPIs, lagging flow heads
and selections outside history. Browser workflows preserve exact dates through
copy, save/reopen, route navigation and Network filters, including custom-form
accessibility. Dataset tests reconcile all 60 source share deltas against the
full historical flows using exact integers. Collector tests reject conflicting
log reads and share-supply mismatches instead of advancing false coverage.

A delayed-script browser regression checks that Network and analytics filters
remain disabled until hydration finishes, then retain the first selection through
native form submission. It runs on desktop and both phone widths. This protects
against React applying server select defaults over an early user selection.
