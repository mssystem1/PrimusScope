# PrimusScope

Independent analytics for the Primus ecosystem: Confidential Finance, zkTLS
Network, public task exploration, developer interfaces and a personal workspace.

The application defaults to **recorded, source-traceable observations**. Optional indexed modes read local SQLite or a hosted PostgreSQL publication
updated by bounded incremental jobs. Finance covers four registered aggregators on BNB Smart
Chain (chain 56); the separate Network sample covers one task contract on Base
(chain 8453). Every dataset carries its contract and block scope, observation time
and source. Private balances, route-attributable TVL/yield and cryptographic proof checks remain
explicitly unavailable when unsupported by the evidence. Public strategy analytics
separately measure USDu assets, sUSDu shares, NAV growth and verified vault flows;
the shared strategy is counted once, not as either Primus route’s holdings.

## Run locally

Use Node 24 and npm 11. From the repository root:

```sh
npm ci --cache .local/npm-cache
npm run dev
```

The checked-in, sanitized observation artifact is sufficient to run recorded
mode. No credentials, database or wallet connection are required for those public
views. The discovery tools optionally use a host-scoped `ETHERSCAN_API_KEY` for
verified contract metadata; never put credentials in browser-prefixed variables
or commit a populated environment file.

To rebuild the application artifact from the retained discovery evidence:

```sh
npm run data:import
```

Recorded production mode bundles this artifact at build time. Rebuild and restart
after importing new observations; importing alone does not refresh a running
production server or change the source observation timestamps.

To run a production build locally:

```sh
npm run build
npm run start
```

For the optional local database/worker workflow, use
[LOCAL_INDEXER.md](docs/LOCAL_INDEXER.md). `indexer:init`, `indexer:once` and
`indexer:status` prepare and advance persistent checkpoints;
`dev:indexed`/`start:indexed` select read-only database serving without editing
managed cloud settings. A completed worker range becomes visible on the next
request. The Sources page distinguishes validated coverage, collector attempts,
provider-finalized targets, lag and retry timing.

The hosted deployment uses read-only PostgreSQL serving and a separate scheduled
collector. See [HOSTED_INDEXER.md](docs/HOSTED_INDEXER.md) for permissions,
15-minute collection, failure behavior and capacity limits.

## Application and API

- `/`: ecosystem overview with separate Finance and Network scopes.
- `/finance`: U/eU and USDT/eUSDT routes; shared-strategy TVL, shares, NAV,
  7D/30D APY and flows; Primus batch activity and lifecycle analytics.
- `/network`: traffic, request cohorts, report coverage and latency dashboards,
  chart drill-down and a filterable public
  event explorer with shareable/saved views, pagination and matching CSV.
- `/explore`: type-aware lookup across recorded public identifiers.
- `/workspace`: public objects saved in this browser, with remove/clear controls.
  Review baselines highlight changed public observations until acknowledged;
  saved views report source updates. See [daily-use analytics](docs/DAILY_USE.md).
- `/developers`: API playground, integration references and verification limits.
- `/developers/verify`: local inspector for the supported Page Core signed-attestation format.
- `/developers/apps`: opt-in Developer Studio pilot for app metadata and bounded diagnostics.
- `/sources`: source links, exact coverage and recorded-data freshness.

Public reads live under `/api/v1`; the machine-readable interface is at
`/api/v1/openapi.json`. Public identifier lookup uses
`POST /api/v1/explore/lookup`. The API reads the same validated artifact as the UI
and makes no upstream RPC request per page load. `GET /api/v1/status/indexer`
reports safe collection status independently of publication availability.
CSV exports preserve event
identity, filters and provenance. Unknown records are described within the
recorded scope, without claiming a proof or transaction is invalid.

[Analytics dashboards](docs/ANALYTICS_DASHBOARDS.md) documents custom UTC dates,
saved selections, metric formulas,
shared-strategy attribution, source/history limits and live collection.
The [history workflow](docs/STRATEGY_HISTORY.md) backfills the complete retained
60-day financial period using keyless public RPC and ABI-decoded events.
[Network activity research](docs/NETWORK_ACTIVITY.md) documents the event
filters, `/api/v1/network/events`, pagination/recovery and snapshot-bound export.

The code is split into `apps/web`, `apps/worker`, `apps/collector`, `packages/api-schema`,
`packages/data` and `packages/storage`.
The shared strict schemas reject unsupported private fields. The data repository
keeps source scope, native contract state and observed events separate. Local
storage commits facts, covered ranges and checkpoints atomically, with lease
fencing, restart recovery, explicit cooldowns and publication quarantine.

## Validation and next stages

See [application checks](docs/TESTING.md) for TypeScript, unit tests and Playwright
desktop/mobile/API workflows. [Discovery tools](scripts/discovery/README.md)
describe bounded chain reads and Python checks. Retained data readiness evidence
is in [docs/discovery/DATA_READINESS.md](docs/discovery/DATA_READINESS.md).
The current implemented scope and verified results are recorded in
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

The [planning package](docs/planning/README.md) defines the wider product and
implementation sequence. Official SDK tools are implemented as a pilot;
genuine positive verification remains unverified because no
public fixture matches the pinned signer. See [SDK_TOOLS.md](docs/SDK_TOOLS.md),
[verification](https://primus-scope.vercel.app/developers/verify) and
[Developer Studio](https://primus-scope.vercel.app/developers/apps). Private wallet authorization,
broader history and provider backup/restore drills remain later stages. SQLite
indexed mode is local; Vercel uses the external PostgreSQL serving adapter.
[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) records configuration needs. Local
validation does not replace tests against a deployed Vercel instance.
