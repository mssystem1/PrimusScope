# Durable local observation store

`@primusscope/storage` is the Node 24 SQLite reference store used by the bounded
local indexer and indexed-mode web server. Its default file is
`.local/indexer.sqlite` beneath the repository. This file is local persistence;
it is not a durable database for Vercel functions. Production needs a separate
durable service/adapter before indexed serving can be deployed there.

The writer uses WAL, full synchronous commits, transactions and expiring
per-domain leases. A commit checks the lease token, previous checkpoint hash,
contiguous range, event identity, registered scope and strict public schemas.
Facts, coverage, checkpoint and published snapshot change together. A failed
transaction leaves all four unchanged. Empty successful ranges advance coverage;
replaying the same completed range is idempotent.

Initialize with the sanitized observation set and the **actual hash of each
domain's exact final covered block**. The worker obtains and checks these hashes
from each verified chain; do not supply a new head or a made-up anchor. Seeded
data retains its original measurement times and does not imply a completed local
indexing run.

`readServingState()` reads the publication and safe status in one transaction.
Use `new SQLiteStore(path, {readOnly: true})` for serving: a missing database fails
closed, with no database creation or schema migration. Indexed mode must not
silently fall back to the bundled recorded artifact.

`recordRun` stores attempt/success/failure times, sanitized error codes, the last
observed finalized target and bounded numeric Retry-After metadata. It never
refreshes chain coverage. Public lag is measured against that recorded target;
it is not a continuously sampled chain head.

A consistency incident quarantines publication while preserving status. Recovery
can rewind only to an already stored range boundary, after the caller verifies
its hash/time against the chain. Rollback removes orphaned facts, invalidates
affected publications and creates a new snapshot identity, including when
returning to previously published content. A deeper or unknown-boundary rewind
remains quarantined for explicit reset/review. Old native-state samples retain
their own pinned block and never become current because a range advanced.

The shared schema limits each domain to 100,000 events. Reaching capacity fails
without advancing or silently dropping history. This local reference retains
publication history; production retention, backups and remote storage capacity
remain separate launch work.

Focused tests cover real SQLite persistence, lease fencing, simultaneous domain
updates, injected transaction failure, fresh read-only readers, bounded capacity,
run/freshness separation, quarantine and rollback. Synthetic anchors exist only
in isolated offline fixtures; they are not live-chain evidence.
