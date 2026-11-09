# Implementation status — 9 November 2026

The local application and a durable incremental indexing slice are implemented
and validated. Default recorded mode uses retained observations; optional local
indexed mode reads completed worker publications from SQLite without a rebuild.
Both modes preserve explicit contract/block coverage and source times. A hosted
continuous feed and production launch remain outstanding.

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
**131 tests** across schema, data, HTTP-helper, API-route, SQLite and worker checks.

Production-server Playwright runs pass **30 of 30 tests**: the original 25
recorded-mode checks plus five isolated indexed-mode workflows.

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

Manual screenshot review prompted larger phone typography. Initial browser
failures also led to contrast and horizontal-overflow fixes; the final tests
were rerun against the rebuilt application. Automated accessibility checks do
not replace broader user testing.

The build has no dynamic-filesystem tracing warning. All 15 deployment trace
manifests were checked: discovery files, `.local` artifacts and `.env` files are
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

1. Provision hosted durable serving storage and a scheduled worker, with tested
   backup/restore, capacity/retention and operational recovery. Local SQLite is
   intentionally refused as a Vercel persistence configuration.
2. Establish deployment/history boundaries, production provider policies and
   independent reconciliation. Expand coverage only with validated sources.
3. Build authentic official SDK verification/diagnostic workflows with explicit
   context, trust and privacy rules. SDK links are currently references, not
   executed integrations or telemetry.
4. Add useful history, filters and saved-view changes based on the indexed data.
   Private positions and authoritative yield remain gated by their integrations.
5. Configure the selected production services in one deployment batch, deploy to
   Vercel and repeat API/UI/workflow/E2E checks against its actual HTTPS URL.

The local milestones above preceded deployment. Source is now published in
`mssystem1/PrimusScope`, and the recorded observation application is deployed at
**https://primus-scope.vercel.app**. See [DEPLOYMENT.md](DEPLOYMENT.md) for project
configuration and deployed-test procedures. Hosted continuous ingestion remains
a separate launch gate. Managed cloud environment settings were not republished.
