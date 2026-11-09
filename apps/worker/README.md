# Bounded incremental indexer

This Node 24 worker appends reviewed public observations to a local SQLite store.
It makes read-only RPC calls and keeps raw event payloads and receipts out of the
database. The app and worker do not need a signing key or wallet connection.

From the repository root:

```sh
npm run indexer:init
npm run indexer:once -- --domain finance --max-blocks 1000 --chunk-size 500
npm run indexer:once -- --domain network --max-blocks 1000 --chunk-size 500
npm run indexer:status
```

`init` imports the checked-in sanitized baseline only after checking its exact
block anchors, source chain and current finalized-target code/implementation pins. An
already initialized store is preserved. `once` processes a finite contiguous
range after the checkpoint and exits. `status` opens an existing store read-only;
it does not create or migrate a database.

The default database is `.local/indexer.sqlite`. A trusted process can set
`PRIMUSSCOPE_DB_PATH`; `--db` takes precedence. `BNB_RPC_URL` and `BASE_RPC_URL`
may repeat the registered source endpoints only; arbitrary provider overrides are
rejected so stored source IDs cannot mislabel another provider. Public read APIs
never accept an RPC URL. Adding a provider requires a reviewed source record.

## Bounds and consistency

Each domain defaults to at most 1,000 new blocks, 500-block chunks, 250 returned
logs per chunk, 100 RPC calls and a 180-second run deadline. Requests have a
ten-second deadline and a two-megabyte response cap. Provider time/range/size
failures shrink log ranges; quota, forbidden, authentication, TLS and capability
failures stop the job. A dense single block stops explicitly. There is no
unbounded retry or polling loop.

Before appending, the worker verifies chain identity, provider-reported finalized
head and the previous checkpoint hash/time. The explicit evidence policy is
`event_history_with_target_pinned_compatibility_v1`: check pinned EIP-1967 proxy
and implementation bytecode on both chains at that finalized target, then recheck
the same target hash and all pins before each chunk is published. Standard
`Upgraded(address)` events are included across every appended interval and
quarantine the affected range. Events reconcile against canonical headers and
transaction receipts. Raw amounts, participants, templates, callback reasons and
attestations are discarded after validation.

A chunk's safe event projection, coverage and checkpoint commit atomically.
An empty successful range advances coverage; a failed chunk does not. Earlier
completed chunks remain committed if a later one fails. Leases fence concurrent
workers. HTTP numeric `Retry-After` is bounded and persisted; another run makes
no RPC request until that cooldown expires.

Hash, implementation, ABI/decode and receipt inconsistencies quarantine the
publication. Restart resumes a trustworthy checkpoint. Reorg recovery is an
explicit reviewed operation using the storage layer's retained-boundary rollback;
the worker never silently discards history or skips forward to the head.

## Limits of the evidence

The Network ABI is from a pinned official SDK, with observed runtime fingerprints;
independent source/bytecode matching remains unestablished. Finalized-target pins
and standard upgrade-event checks do not independently establish arbitrary
historical ABI intervals: historical `eth_getCode`/`eth_getStorageAt` are not
required or claimed at each event height under this policy. This narrower evidence
model also does not establish independent completeness/finality. A single RPC is still a provider trust
boundary. The worker does not establish full deployment history, a proof census,
private balances, yield or cryptographic attestation validity.

On 9 November 2026, a fresh BSC historical `eth_getCode` call returned an archive
capability restriction. That motivated the explicitly narrower finalized-target
policy above, consistent with the original target-pinned event discovery. Code
and implementation checks at the finalized target remain mandatory. Archive
restrictions on required reads surface as `RPC_ARCHIVE_UNAVAILABLE` and stop the
affected job. Gaps are never skipped or presented as indexed.

Worker tests use deterministic fake RPC with real temporary SQLite files. They
exercise close/reopen/resume, empty ranges, partial jobs, provider limits,
cooldowns, source changes, malformed events and receipt mismatches. They also
compare event layouts to the retained official/explorer evidence.
