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
validated publication and lease in one envelope. Events use versioned fixed
columns, with repeated provenance and canonical IDs reconstructed losslessly.
The entire envelope is binary gzip, avoiding Base64's approximately 33% encoding
overhead. Readers also accept the previous JSON/gzip-Base64 format. Writers
read the origin with a strong ETag (`Accept-Encoding: identity`)
and use conditional writes. Lease acquisition and final publication each use one
write. The final write checks the lease and expected revision, increments the
revision and releases the lease atomically. A stale collector cannot overwrite
a newer publication or erase its lease. The 600-second lease exceeds the
300-second job limit; local freshness checks avoid extra renewal writes.

Hourly jobs can scan up to 40,000 blocks per domain in at most 5,000-block
chunks. Native reads have a 2,000-request ceiling, at most eight starts per
second and the existing shared 240-second budget. These limits accommodate
Base block production better than the earlier 10,000-block cap. A busy or
limited source may still leave a visible backlog; no caught-up SLA is implied.

Cron runs **hourly** (`0 * * * *`, UTC). At two writes per successful job this is
1,440 publication writes in 30 days. Initialization, failed-job lease release,
failure status and manual invocations also count. Hosting and Blob follow the
account's actual plan, credits and limits. This is not unlimited free storage or
transfer. Each publication overwrites the same object; old full snapshots are
not appended on each run. History still grows as new on-chain events are kept.

Readers share concurrent requests and cache validated Blob publications in each
server process for five minutes; Blob edge caching can add up to 60 seconds.
Cold starts and independent server instances still consume reads and transfer.
Traffic is not guaranteed to remain within the free allowances. The existing
validated-publication limits remain bounded: 64 MB decompressed for Blob and
100,000 events per domain. The separate Neon adapter retains its 16 MB limit.
Reaching a capacity limit refuses advancement and retains the last publication;
this release does not implement an unbounded warehouse or automatic history
deletion. Failed uploads
leave the prior object intact. Provider quota can still prevent object reads.

## 26 November: publication capacity incident

The last successful publication was revision 119, committed on 22 November at
13:00 UTC. Vercel continued invoking the hourly collector, but it returned HTTP
503. An authenticated reproduction returned `CAPACITY_EXCEEDED`. The retained
publication was 15,954,704 bytes uncompressed, just below the inherited
16,000,000-byte application limit; the compressed Blob object was about 4.59 MB.
This was an application guard, not evidence of a Blob storage-quota failure.

The same retained revision was measured before and after lossless compaction:
15,954,704 bytes of full JSON become 8,672,898 bytes of compact event data, and
the stored envelope falls from 4,591,041 to 3,194,363 bytes (**30.4% less storage**).
The expanded publication compares equal, including all 63 Finance events and
25,057 Network events, source coverage, strategy records and checkpoints.
Raw Brotli and an explicit hash dictionary were also measured; they did not
improve enough over compact gzip to justify their complexity or runtime cost.

Blob now has its own 64,000,000-byte decompressed budget. The same limit reaches
the temporary SQLite restore/export path, so a later job can resume a larger
publication. Neon keeps its original budget and remains read-only history.
The event guard remains 100,000 per domain. No observations or checkpoints are
deleted or reset. This restores bounded headroom; partitioned history is still
needed for continued growth beyond these limits. Compaction does not turn
indefinitely growing event history into a fixed-size dataset. Overwrite is
appropriate for checkpoints, mutable current state and replaceable summaries;
overwriting old raw events would remove historical explorer detail. A future
partitioned store should retain immutable compressed raw-event partitions and
overwrite only its small manifest/current state and derived daily rollups.

Sources distinguishes retained-data availability from collection freshness.
Global publication failures use a separate small private status object, so a
failed upload can be reported without replacing the last validated data.
Failure-status writes are best-effort; age-derived stale warnings still work
when that object is unavailable. An older failure is superseded by a newer
published collector attempt. Approaching byte/event limits are disclosed.
Scheduled status becomes stale after its cadence plus 30 minutes of grace.
After recovery, finite job budgets can leave a backlog while stored ranges
advance; the last observed head does not establish the current chain head.

### Catch-up recovery and dashboard refresh

Restoring publication does not immediately fill the outage period. Each regular
hourly run is bounded at 40,000 blocks per chain. The one-off
[recovery workflow](../.github/workflows/recover-indexer.yml) invokes those same
validated jobs consecutively until both observed finalized targets are reached.
It stops after 80 invocations or 150 minutes, on capacity/quarantine/provider
errors, or when no progress is possible. A busy scheduled collector gets its
lease first; recovery waits and resumes. Separate shared-strategy flow
reconciliation failures do not discard successfully validated chain ranges.

The workflow uses a short-lived GitHub OIDC identity. The collector checks the
RS256 signature against GitHub's public keys, exact issuer/audience, repository
ID, main branch, recovery-workflow path, event and expiry. Fork/PR identities
and other workflows are refused. No new stored secret is required. Recovery
starts when this workflow file changes on main and also supports a manual
Actions dispatch; the normal Vercel hourly cron remains unchanged. The workflow
waits for the matching collector deployment before starting.

Public data views show coverage-through and collection timestamps
separately. Recently collected data with a known remaining head gap is
`catching_up`, not `fresh`. Open public dashboards check for a new publication
or changed source status every 60 seconds while visible, retaining the chosen
URL filters. Refresh runs once in the shared layout across public pages,
including Sources, Explorer and Workspace. Developer sessions are excluded so
private SDK inputs are preserved. Server publication caching can add up to five minutes and Blob
edge caching up to one minute. Background reads never start RPC collection and
an unavailable status response does not clear existing analytics. SDK proof
input pages do not poll or refresh this way. Finance separately identifies flow
history that trails its assets/share/NAV measurements; newer stock samples do
not imply that missing deposits or withdrawals have been restored.

The 26 November stock repair added ten independently sampled historical points
and preserved all existing stock samples, Finance/Network events and flows.
The live strategy then contained 190 points with no stock-series gaps, and both
7D and 30D APY were computable. [Recorded public source evidence](discovery/stock-recovery-2026-11-26.json)
contains the exact blocks, hashes and raw accounting values. A bounded rolling
30-day anchor lookup maintains the existing two-hour APY lookback tolerance;
it does not substitute approximate returns when historical reads fail.

Finance flow collection now uses the keyless public BSC archive at
`https://bsc.rpc.sentio.xyz`, listed in the [public chain registry](https://chainlist.org/chain/56).
[Archive verification evidence](discovery/bsc-sentio-archive-2026-11-26.json)
matches a retained deposit and a post-cutoff withdrawal, including its header,
receipt and exact historical share-supply change. No account, API key or new
environment variable is required. The public endpoint enforces its own limits;
this integration has no paid fallback or automatic upgrade.

The transport partitions log requests into at most 1,000 blocks, preserving
both topic and address reads. Logical recovery ranges are bounded at 100,000
blocks; ordinary hourly flow collection uses 10,000 blocks, at most 60 events,
200 RPC requests and 60 seconds. Result count and bytes remain bounded. Before
advancing a historical interval, collection rechecks a known retained event by
canonical transaction/log identity. Legacy baseline display IDs remain intact.
Share-supply reconciliation, cross-provider accounting headers, per-event block
and receipt checks and final boundary rechecks still apply. A strict secondary
read can recover a partial primary response only when its union reconciles and
passes those same checks. Provider limits or unreconciled changes preserve the
previous verified interval.

Sources shows strategy stock measurements and flow history separately, with
their own counts, source times, blocks and flow providers. New stock samples do
not establish newer deposits or withdrawals.

The [26 November flow repair](discovery/flow-recovery-2026-11-26.json) published
766 additional validated events across 32 contiguous ranges, extending the
retained 4,098-flow baseline to 4,864 flows through block 135,901,316
(26 November, 19:18:25 UTC). Publication revision 166 preserved every existing
Finance event, Network event, stock sample and collector checkpoint. Both the
initial and final flow boundaries were rechecked against the archive and the
separate accounting provider before the fenced publication. Hourly collection
continues from that boundary with the archive transport.

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

During recovery, SDK metadata writes were paused. Task 3 now stores new SDK
metadata under a separate private Blob prefix. Neon stays history-only; removing
Blob mode still blocks mutations with `HISTORY_READ_ONLY`. See
[SDK_TOOLS.md](SDK_TOOLS.md) for the restored workflow and genuine Core reference.

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
