# Blob collection and read-only Neon history

On 17 November 2026, Neon began refusing publication reads during a quota
outage. The web app now separates current collection from historical storage:

- **Private Vercel Blob** holds new public observations and collector checkpoints.
- **Neon** remains unchanged, as read-only historical storage. No publication
  records were exported, migrated or copied from Neon into Blob.
- `/history` and `/api/v1/history/neon/*` read Neon only when explicitly requested.
  A failed history read does not prevent current dashboards from loading.

## Source boundaries

The new Finance and Network scopes start at freshly checked finalized BSC and
Base blocks on 17 November. Initialization verifies chain identity, registered
contract/runtime fingerprints, anchor logs and receipts. It does not claim the
older Neon period is present in Blob. Finance remains BSC; Base is the separate
zkTLS Network source.

The retained public strategy baseline in the repository remains available,
separately from these new scopes. It is not a Neon export. Missing stock days
between that baseline and new samples remain visible gaps; charts do not join
across those gaps, and period coverage reports incomplete stock history. New
flow backfill is bounded and does not imply full historical coverage.

## Configuration

The store is connected only to Production in both projects; Preview and
Development must use separate stores and collector secrets if enabled. The
fixed object pathname is shared state within one store.

Both Vercel Production projects receive `PRIMUSSCOPE_PUBLICATION_STORE=blob`,
`PRIMUSSCOPE_NEON_HISTORY_ONLY=1`, `BLOB_STORE_ID` and the native integration's
server-only `BLOB_READ_WRITE_TOKEN`. The web app retains
`PRIMUSSCOPE_DATA_MODE=hosted` and its existing SELECT-only `WEB_DATABASE_URL`
for explicit history reads. The collector keeps `CRON_SECRET` and the existing
strategy flag. Its Blob path does not open Neon or prune diagnostic records.
Existing Neon records and credentials are left in place.

Blob is private. Tokens are never sent to browsers. The web adapter refuses
writes in code; the native Blob credential itself is a read/write credential,
not a provider-enforced read-only token. Deployment tracing excludes local
`.env*`, `.local`, discovery and research files. No managed Codex environment
publication is needed for this Vercel configuration.

## Atomic publication and cadence

A fixed private object, `primusscope/current-v1.json`, contains the revision,
validated publication and lease in one envelope. The publication is gzip/base64
encoded. Writers read the origin with a strong ETag (`Accept-Encoding: identity`)
and use conditional writes. Lease acquisition and final publication each use one
write. The final write checks the lease and expected revision, increments the
revision and releases the lease atomically. A stale collector cannot overwrite
a newer publication or erase its lease. The 600-second lease exceeds the
300-second job limit; local freshness checks avoid extra renewal writes.

Cron runs **hourly** (`0 * * * *`, UTC). At two writes per successful job this is
1,440 writes in 30 days, against the documented Hobby allowance of 2,000 advanced
operations. Initialization, failed-job release and manual invocations also count.
This is a budget, not unlimited free storage. Other documented allowances are
1 GB storage, 10 GB transfer and 10,000 simple operations per month. Monitor the
actual account's limits before increasing frequency. A validated live snapshot
of about 1.90 MB raw occupied about 686 KB in the compressed envelope.

Readers share concurrent requests and cache validated Blob publications in each
server process for five minutes; Blob edge caching can add up to 60 seconds.
Cold starts and independent server instances still consume reads and transfer.
Traffic is not guaranteed to remain within the free allowances. Failed uploads
leave the prior object intact. Provider quota can still prevent object reads.

## Outage behavior

Primary reads have a three-second deadline and a 60-second failure cooldown.
A warm instance serves its last validated publication with its original source
range and timestamps. A cold instance uses the bundled, validated recorded
snapshot and clearly labels recovery mode. This cold snapshot is older than the
latest Blob publication; it is not described as current or as Neon history.
Known quarantined observations remain blocked rather than being served through
recovery. No page-load request starts on-chain collection.

Neon history has its own three-second read deadline and no substituted dataset.
While the provider rejects reads, it displays an unavailable message. Existing
Neon contents have not been removed, but restoring provider access remains
necessary to browse that historical period.

`PRIMUSSCOPE_NEON_HISTORY_ONLY=1` also blocks Developer Studio metadata mutations
and diagnostics ingestion/retention with `HISTORY_READ_ONLY`. Local official SDK
signature inspection still works; hosted diagnostic writes are paused. This
storage change does not establish the pilot's outstanding genuine-positive
attestation verification gate.

## Verification

Unit checks cover compression, conditional write conflicts, leases, read-only
access, fresh chain initialization, publication coalescing, cache recovery,
quarantine and history isolation. A real Blob stale-ETag attempt was rejected
and the stored bytes remained unchanged. New collection was bootstrapped from
RPC without reading or exporting Neon records.

`npm run test:e2e:recovery` starts an isolated production server with unavailable
stores and tests APIs, dashboard loading, accessible mobile reflow and history
failure on desktop and two phone sizes. It uses no production credential.

After deployment, run the read-only current-Blob checks:

```sh
E2E_DATA_MODE=blob E2E_BASE_URL=https://primus-scope.vercel.app npm run test:e2e
```

This includes API, current dashboards, source/coverage disclosure, independent
history failure and local SDK workflows. The older hosted canary intentionally
writes temporary diagnostic projects and assumes the old source epoch; it is
not the correct release suite while Neon is historical and read-only.
