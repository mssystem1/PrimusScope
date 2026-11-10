# Implementation status — 10 November 2026

Finance and zkTLS Network now have calendar analytics dashboards, interactive
charts, exact chart CSV and accessible data tables. Finance preserves U/eU and
USDT/eUSDT as primary routes and separately measures the shared Unitas strategy:
61 daily assets/share/NAV samples across 60 days, geometric 7D/30D APY and
4,098 receipt-verified public flows across the same retained 60-day period.
All 60 daily net-share changes reconcile with on-chain share supply. These totals are not private
Primus positions or route-attributable TVL. Network charts cover traffic, request
cohorts, first-report latency and report distributions. See
[ANALYTICS_DASHBOARDS.md](ANALYTICS_DASHBOARDS.md).

Both dashboards now support exact inclusive UTC calendar dates, source-specific
coverage, explicit partial boundary buckets and saved/shareable analytical
selections. Historical financial KPIs use the selected period’s last sample;
missing periods display unavailable values.

Network activity research now includes conjunctive event/task/block filters,
newest-first pagination, chart-interval drill-down, shareable and browser-saved
views, JSON reads and matching CSV with an on-page snapshot-refresh workflow.
Ranges outside published coverage are rejected. See [NETWORK_ACTIVITY.md](NETWORK_ACTIVITY.md).

Hosted release validation: both Vercel projects are deployed, Neon Free is seeded,
and an authorized collector invocation advanced both chain scopes by 10,000
blocks without rebuilding the public app. The deployed checks passed 17 desktop/
mobile workflows and four API tests. These results and explicit remaining
backlog/operational limits are retained in
[hosted-release-observation.json](hosted-release-observation.json).

The local application and a durable incremental indexing slice are implemented
and validated. Default recorded mode uses retained observations; optional local
indexed mode reads completed worker publications from SQLite without a rebuild.
Both modes preserve explicit contract/block coverage and source times. A hosted
PostgreSQL adapter and scheduled Vercel collector are now implemented, with
deployment-specific validation tracked separately from local results.

## Working scope

- Responsive Overview, Finance, zkTLS Network, Explorer, Workspace, Developers and
  Sources screens, with public batch and contract-scoped task detail pages.
- BSC Finance: four registered aggregators, nine events and four observed batches.
  USDT has seven events across three batches; U has two events in one batch.
- Separate Base Network: 116 requested task IDs, 90 report events and 17
  withdrawals. The selected native SUCCESS sample remains separate from
  cryptographic attestation verification, which was not run.
- Read-only JSON API, strict input validation, coverage-aware lookup/errors,
  snapshot-bound pagination, metric definitions, OpenAPI document and filtered
  CSV exports retaining event identity and provenance.
- Browser-local saved public objects, remove/clear controls, and a working API
  playground. No account or wallet is needed for public reads.
- Shared schemas, a deterministic observation importer and a data repository.
  Unsupported financial metrics stay unavailable; private payloads are excluded.
- Bounded incremental worker, SQLite transactions, lease fencing, exact seed
  hash checks, restart/resume, provider cooldowns, safe source quarantine and
  explicit retained-boundary rollback support.
- Read-only indexed serving and Sources status showing coverage, collector
  attempts, finalized-target lag and retry timing separately.

## Validation evidence

The final production build and `npm run typecheck` pass. `npm test` passes
**204 tests** across schema, data, HTTP-helper, API-route, SQLite, PostgreSQL role/
lease/publication, hosted recovery, transport and worker checks.

Production-server Playwright runs pass **51 of 51 tests**: 46 recorded-mode
checks plus five isolated indexed-mode workflows.

- Eight API checks, including counts, unavailable values, typed lookup, invalid
  inputs, pagination and scoped CSV reconciliation.
- Finance directory → route → batch, task lookup → detail, missing-record
  coverage wording, saved-item persistence/clear and developer API workflows.
- Desktop automated accessibility checks across all seven modules and a task
  detail page, plus keyboard navigation and source/chart disclosures.
- Mobile navigation, focus/Escape behavior, automated accessibility checks and
  page reflow at 360 and 390 pixels, including task and batch detail pages.
- Indexed publications changing without rebuild, writer process reopening,
  replay safety, cursor expiration, failure/backlog disclosure and recovery.
- Financial chart data, legend controls, keyboard inspection, period changes and
  chart CSV; Network cohort API/UI reconciliation and dashboard WCAG scans.
- Network filters, copy/share, save/reopen/reset, real CSV downloads, export
  refresh prompts, stale-page recovery and chart drill-down at all three widths.
- Delayed-script hydration checks on desktop and both phone widths prevent
  early filter selections from being reset to their server defaults.

Manual screenshot review prompted larger phone typography. Initial browser
failures also led to contrast and horizontal-overflow fixes; the final tests
were rerun against the rebuilt application. Automated accessibility checks do
not replace broader user testing.

The build has no dynamic-filesystem tracing warning. Deployment trace
manifests are checked: discovery files, `.local` artifacts and `.env` files are
excluded. This is local packaging evidence, not a deployed Vercel test.

Commands and report locations are documented in [TESTING.md](TESTING.md).

## Bounded live indexing evidence

The real worker initialized both chains, collected 1,000 additional blocks per
domain, then reopened the database in a new process and collected the next 100
blocks per domain. Resume ranges were contiguous and event identities remained
unique. Finance added zero recognized events in these 1,100 blocks; Network
added 20. The resulting local publication contains nine Finance events and 243
Network events.

The production web/API served that exact stored publication. Source screenshots
and API checks confirmed its coverage and explicit remaining backlog. This is
a bounded collection trial, not a caught-up or continuously running service.
See [retained live evidence](discovery/incremental-indexer-observation.json) and
[the operating workflow/policy](LOCAL_INDEXER.md).

BSC historical code reads returned an archive restriction. The explicit event
policy validates retained seed hashes, finalized-target fingerprints, upgrade
events, receipts and block identities. It does not establish every historical
implementation interval or independent consensus.

## Remaining product work

1. Rehearse provider backup/restore, establish capacity/retention and expand
   operational recovery for the hosted publication. The PostgreSQL adapter and
   15-minute collector are implemented; local SQLite remains intentionally
   refused as a Vercel persistence configuration.
2. Establish deployment/history boundaries, production provider policies and
   independent reconciliation. Expand coverage only with validated sources.
3. Build authentic official SDK verification/diagnostic workflows with explicit
   context, trust and privacy rules. SDK links are currently references, not
   executed integrations or telemetry.
4. Expand validated financial stock/flow history and Network coverage. Public
   shared-strategy yield is implemented; private positions and Primus-attributable
   balances/returns remain gated by their integrations.
5. Keep API/UI/workflow/E2E checks against the actual HTTPS deployment distinct
   from local fixture results, including collection advancing without a rebuild.

The local milestones above preceded deployment. Source is now published in
`mssystem1/PrimusScope`, and the recorded observation application is deployed at
**https://primus-scope.vercel.app**. See [DEPLOYMENT.md](DEPLOYMENT.md) for project
configuration and deployed-test procedures, and [HOSTED_INDEXER.md](HOSTED_INDEXER.md)
for the scoped hosted implementation and its limits. Managed cloud environment
settings were not republished.
