# Local incremental indexing

PrimusScope keeps two explicit serving modes. The default recorded mode bundles
the retained discovery artifact at build time. The optional local indexed mode
reads an existing SQLite database on each request, so a completed worker range
can appear without rebuilding the web application.

This database belongs to the local durable worker. It is not a Vercel persistence
solution. Indexed serving refuses a Vercel runtime until an external durable
serving adapter is configured; the recorded preview remains independently
deployable. No managed environment publication is needed for local indexing.

## Local workflow

From the repository root, with Node 24 and installed workspace dependencies:

```sh
npm run indexer:init
npm run indexer:once -- --domain finance --max-blocks 1000
npm run indexer:once -- --domain network --max-blocks 1000
npm run indexer:status
```

Initialization starts from the retained bounded Finance and Network samples.
The worker checks each chain and the exact seed header before anchoring the
checkpoint, and validates known contract fingerprints at a provider-finalized
target. It does not invent a deployment block or discard the interval
between the seed and the current head. Repeating a run continues from the saved
checkpoint. A bounded run can still leave a backlog; inspect the status.

Start the local indexed UI with either:

```sh
npm run dev:indexed
```

or, after a production build:

```sh
npm run start:indexed
```

The launchers select indexed mode and the default
`.local/indexer.sqlite` database for their child process. They do not change
cloud environment settings. `npm run dev` and `npm run start` retain the default
recorded mode. The web process opens the database read-only; public requests
never start a worker or proxy RPC calls. Use the Sources page's refresh control
to reread completed stored observations.

For an explicitly selected local database, a trusted shell configuration may
set `PRIMUSSCOPE_DB_PATH` to an absolute path. Do not use the E2E fixture database
for normal collection. Database files, WAL files, test databases and runtime
reports stay under ignored `.local` storage.

## What completion means

A completed range is contiguous with the previous checkpoint, stays at or below
the provider-reported finalized head and passes the configured source checks.
Events, coverage, boundary hash, checkpoint and serving publication commit
together. Empty ranges advance coverage too. Failed or incomplete chunks do not
advance the published watermark.

The worker has finite block, request, response, event and time budgets. RPC
timeouts or range-size failures shrink the requested interval. It never retries
indefinitely or silently switches to paid access. Both registered chains use
their separately validated keyless PublicNode endpoints; Etherscan remains an
optional supported-metadata source, not an event-source fallback.

Implementation/code pins apply to the Finance proxies and the Network proxy.
The event decoder uses retained source evidence, finalized-target code checks
and upgrade-event checks across every appended interval. This is an explicit
event-evidence policy, not a claim that historical storage/code was independently
queried at every event block. BSC's free endpoint can reject old code reads as
archive access, even when historical events and block headers are available.

An observed upgrade, changed fingerprint, incompatible decoding or unsafe reorg
recovery quarantines publication. Recovery is explicit and limited to retained
checkpoints; the one-shot worker stops on a reorg rather than choosing an
unverified rewind automatically. A reorg before the seed requires source
reconciliation; it cannot justify a made-up rewind range. Historical ABI
interval approval and independent-provider reconciliation remain launch gates.

Only allowlisted public event metadata is stored. Amounts, participant graphs,
SDK subjects, proof bodies and task-result payloads remain excluded. Previously
sampled native states retain their original as-of blocks and do not become
current state merely because new events were collected.

## Interpreting status

`GET /api/v1/status/indexer` exposes safe operational metadata:

- Stored coverage and indexed-through block for each domain.
- Last collection attempt/outcome and successful run time.
- Last observed provider-finalized target and remaining block lag.
- Publication availability and fixed, sanitized issue codes.

Coverage observation time, finalized-head observation time and worker attempt
time are separate. A failed run cannot make old source observations fresh.
Lag is measured against the last observed provider target, not an independent
consensus guarantee. A successful one-shot job does not imply a continuously
running service.

The current schema caps an observation set at 100,000 events per domain. Capacity
exhaustion must stop collection explicitly; retention and historical query
partitioning need a separate policy. Full history, backup providers and hosted
worker operations remain later launch gates.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:e2e:indexed
```

The indexed browser suite uses its own sanitized fixture database and local
server. It tests serving updates without a rebuild, durable reopening, cursor
expiration, failure/lag reporting and mobile presentation without contacting
upstream RPC providers. Live worker checks are separate bounded, read-only
observations and must not be confused with fixture tests or Vercel validation.
