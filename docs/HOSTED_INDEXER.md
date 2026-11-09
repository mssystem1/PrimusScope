# Hosted observation collection

The hosted adapter uses Neon Free PostgreSQL for durable publications and a
separate Vercel project, `primus-scope-collector`, for bounded collection. The
public application is `primus-scope`; both projects use the existing Vercel team.
No paid database plan or paid data API is selected. Vercel execution uses the
account's existing plan and quotas; this is not a promise of unlimited free hosting.

## Configuration and access

| Runtime | Production settings | Database permission |
| --- | --- | --- |
| Public web, `apps/web` | `PRIMUSSCOPE_DATA_MODE=hosted`, `WEB_DATABASE_URL` | SELECT on the publication table only |
| Collector, `apps/collector` | `WORKER_DATABASE_URL`, `CRON_SECRET` | Publication/checkpoint and lease writes |
| One-time administration | Provider admin connection in ignored `.local/neon-admin.env` | Schema and role setup; never a web runtime credential |

The native integration is disconnected from the public project after bootstrap
so its administrative connection variables are not inherited by web deployments.
The database resource remains provisioned. Runtime credentials are encrypted
Vercel production settings, without preview/development inheritance. None uses a
`NEXT_PUBLIC_` prefix. Managed Codex environment settings do not need republishing.

The controlled bootstrap is `node --use-env-proxy --import tsx
scripts/bootstrap-hosted.ts` from the repository root. It creates random runtime
credentials in an ignored file with mode 0600 before changing SQL roles, then
reuses those credentials on rerun. It validates the retained chain anchors and
current implementation fingerprints before initial seeding. It never prints
credentials. Provider terms must be accepted by the account holder.

## Collection and publication

Vercel Cron invokes GET `/api/collect` every 15 minutes. The route requires
`Authorization: Bearer <CRON_SECRET>`; unauthorized requests stop before SQL or
RPC work. Query parameters are refused. The endpoint is not a public RPC proxy.
Node 24 and a 300-second function limit are required. Each job targets a bounded
240-second collection budget and at most 10,000 additional blocks per domain.
Registered keyless PublicNode endpoints supply BSC Finance and Base Network data.

A database-clock global lease prevents overlapping collectors. Each job restores
the latest validated PostgreSQL publication into private temporary SQLite, using
the existing transactional reducer and validation policy. After each domain, an
atomic PostgreSQL replacement requires both the current lease token and expected
publication revision. Stale collectors cannot replace newer data or release a
successor's lease. Temporary SQLite is deleted after the job; it is not durable
Vercel storage. Completed ranges survive a later domain failure or job restart.

The web reader checks the current database revision on each request and reuses a
validated in-memory publication only while that revision matches. Database
failures return an unavailable response; hosted mode never silently substitutes
the recorded artifact. Quarantine status stays readable while observation reads
are paused. Readers do not initiate upstream chain requests.

## Operational limits

Sources shows the last validated range, observation time, collector attempt,
last success, provider-finalized target, measured lag and cooldown separately.
Scheduled mode uses a freshness tolerance of two intervals plus two minutes;
recent validation does not mean the history backlog is caught up. Cron can be
delayed, and its configuration alone does not prove that a scheduled invocation
has run. Check timestamps and actual invocation evidence.

This beta stores one current JSONB publication, limited to 16 MB and the existing
100,000-event limit per domain. It is not an unbounded analytical warehouse.
Capacity failures preserve the last committed publication. SQL projections,
retention and a rehearsed provider backup/restore procedure remain follow-up
work before broad history expansion. Do not claim an independent backup from a
successful collector restart test.

Historical archive-code validation and independent chain consensus are not
established. The event policy verifies retained seed hashes, finalized-target
code/implementation fingerprints, recognized upgrade events, receipts and block
identities. A source inconsistency quarantines publication. Job restore retains
the current anchor, not old rollback ranges: do not automatically clear
quarantine or reset checkpoints. Investigate source evidence and rehearse any
reviewed replay in isolation before replacing production state.

Inspect safe state with `npm run indexer:hosted -- status` when the worker
credential has been loaded securely. A manual CLI run is labeled manual; only
the scheduled endpoint records the 15-minute scheduler. Do not print DSNs,
authorization headers, raw private inputs or database credential files in reports.
