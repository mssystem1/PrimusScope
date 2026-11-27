# Partitioned Blob storage

The app's 64,000,000-byte guard limits the **decoded publication processed in
memory**. It is not a Vercel Blob account quota or file-size limit. Blob's
[documented maximum individual file size](https://vercel.com/docs/vercel-blob/usage-and-pricing#size-limits)
is 5 TB. Hobby includes 1 GB/month of storage; Pro storage is usage-based.
Functions [default to 2 GB of memory](https://vercel.com/docs/functions/limitations#memory-size-limits),
with up to 4 GB on Pro/Enterprise. JSON parsing, validation, caches, analytics
and the job-local database can hold multiple representations of the same data.
The function memory limit is not a supported JSON dataset size.

## Layout

The v2 format retains the same private root pathname,
`primusscope/current-v1.json`. It contains revision, lease, complete publication
metadata, stock samples, inline event tails and ordered archive references.
Each full 2,000-record group is stored once at
`primusscope/archive-v1/{kind}/{sha256}.json.gz`, for Finance events, Network
events or shared-strategy flows. Tails contain fewer than 2,000 records per
kind and stay in the replaceable root, avoiding a new orphaned tail every hour.

Archive hashes cover canonical decoded JSON, including reconstruction context.
Readers verify schema, hash, byte length, count, kind, source/contract context
and order before full publication validation. Original IDs, address casing,
coverage, checkpoints, event order and financial values are preserved. Neon is
not accessed or changed by this layout.

## Atomic publication and failures

The same root ETag fences lease acquisition, publication and release. Lease-only
writes preserve the existing layout without uploading archives. Publication
creates and verifies new immutable objects before replacing the root. Existing
archives are reused. An already-existing object after an interrupted upload is
read at origin and checked rather than overwritten. After uploads/compression,
the original lease expiry is checked again; the final put uses the original
strong ETag. Upload failures and stale writes retain the previous root.

Archives staged before a failed root commit may remain unreferenced and are
reusable on retry. This release does not delete orphaned or replaced historical
objects automatically. Metadata-only revision reads and lease release do not
depend on archive availability. Readers fetch at most four archives concurrently
and use a process-wide LRU of verified parts, bounded to 64 entries and 16 MB
of decoded archive JSON, isolated by transport and credential digest.

## Measurements and limits

The [27 November shadow measurement](discovery/partition-shadow-2026-11-27.json)
used the existing 21,527,140-byte decoded dataset. Its previous root was
4,252,764 bytes compressed. The proposed root was 171,111 bytes, with 19 archive
objects totalling 4,088,890 bytes. The total stored data is approximately the
same; **root bytes rewritten fall by 95.98%**. This does not mean a 95.98%
reduction in total storage. New history still adds records.

Real private-Blob shadow reads preserved the exact publication. Cold reads took
1.4–2.7 seconds in the cloud workspace; warm reads took 0.5–0.7 seconds without
archive GETs. Local RSS across the retained source, plan and repeated checks
reached about 519 MB; it is not an isolated per-request memory guarantee.
Blob reads therefore have a six-second deadline, and background status polling
allows eight seconds. A failed read continues to use the existing labelled
recovery behavior. Neon history retains its separate three-second deadline.

Individual decoded archives are capped at 4 MB; the root has a 32 MB decoded
guard. These are application safety bounds. Full reconstructed publications
still have the 64 MB processing guard and schema caps of 100,000 events per
chain dataset, 20,000 strategy flows and 5,000 stock samples. Partitioning
improves writes and read reuse; it does not turn the current in-memory query
engine into an unlimited history warehouse. Supporting datasets beyond those
guards requires bounded queries over archive partitions and/or rollups.

## Rollout

Deploy readers that accept legacy JSON, gzip/Base64, compact v1 and partitioned
v2 to both web and collector first. Keep v1 writes until those deployments are
ready and validated. Then opt the collector into partitioned writes. The first
successful fenced publication migrates the existing Blob history without
changing observations. No new environment variable or provider account is
needed. Every compatible writer preserves v2 after encountering it, including
older operators using the default constructor option.

After migration, roll back only to a version that reads and preserves v2. A
format downgrade, if ever necessary, must serialize the latest validated data
under the same lease/revision/ETag rules, rather than restoring an old root and
discarding later observations.
