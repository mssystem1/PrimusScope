# Data-source decision: free explorer API first

**Latest user decision:** prioritize BSC Confidential Finance and use the user's Etherscan Free account for chain 56. [Decision 11](11-bsc-finance-first.md) supersedes the temporary Base free-RPC selection recorded below. No more Base provider research is a prerequisite for this first slice.

**Current selection superseding the original explorer-first preference:** the user chose path 1, Base using bounded free RPC. The [discovery utility](../discovery/README.md) is now implemented and tested offline. Its live run stopped at an environment proxy denial before any chain data was retrieved. No paid explorer is enabled, and no chain/provider switch is authorized by a failed probe alone. The original evaluation and alternatives below remain decision history.

Updated user requirement, 8 November 2026: **data APIs should be free**. This revises the earlier RPC-first recommendation. No paid data plan, credit-card-required upgrade or paid automatic fallback is assumed. Runtime infrastructure has a separate budget decision; a free data API does not establish free worker/database hosting.

User evidence update: a supplied Blockscout DevPortal screenshot explicitly states that Base, Polygon and ZkSync are no longer available on the Free tier starting **October 1, 2026**. This resolves the practical Base eligibility question for this plan: **exclude hosted Blockscout Base from the free-source selection**. Do not retry it hoping generic free-tier wording overrides that notice. Etherscan Base has not qualified as a free source either; no paid Base explorer is part of the plan.

## Recommended architecture

Prefer a free explorer API for indexed events, transactions, receipts, ABI/source metadata and public-address history, after validating the actual selected chain and endpoints. One worker incrementally ingests and caches data in Postgres; visitors query our API instead of consuming an external quota on every page refresh.

Use small, bounded free RPC reads only where required and supported: chain/code/proxy checks, missing contract-state reads or finality verification. Large full-history `eth_getLogs` scans are not the primary plan. Properly bounded RPC is not inherently stuck, but node log-range limits and timeouts make explorer indexes attractive for this workload.

Explorer APIs also have rate limits, record caps, indexing delays, missing-history risks and plan restrictions. An HTTP 200 can contain an API error or truncated page. They do not remove the need for coverage accounting, checkpoints and correct task semantics.

## Candidate evaluation

| Source | Useful role | Free-access gate |
| --- | --- | --- |
| Etherscan API V2 | Indexed logs/transactions, verified ABI/source and supported proxy reads | Verify the current chain AND endpoint are included on a free key; supported chain does not necessarily mean free-plan access |
| Hosted Blockscout API | Address/event/transaction history and source metadata on eligible chains | Base excluded by user-supplied DevPortal notice; verify any other chain's entitlement, version and pagination separately |
| Free public JSON-RPC | Occasional code/state/block checks or small missing ranges | Verify chain, rate/range/history limitations; no assumption of archive state or unlimited backfill |
| Existing hosted Primus dataset/subgraph | Potential shortcut | No complete authorized free dataset has been validated; do not design around a hypothetical one |

The first launch chain is the intersection of: an active official Primus deployment, useful observable data, safe publication, and a verified free source. Base remains a candidate. Official SDK source also has other chain seeds, but their live deployments/activity/free-source support must be checked before switching.

## Current evidence and limits

- Official Etherscan API guidance in `etherscan/skills` at commit `91f96cf42c4e4300c7e1a24314588d1454dd47d1` documents the V2 envelope and explicitly distinguishes current chain/endpoint/plan restrictions. It does not justify a claim that all Base data is free. Source: [API reference](https://github.com/etherscan/skills/blob/91f96cf42c4e4300c7e1a24314588d1454dd47d1/skills/etherscan/references/api.md).
- Official Blockscout documentation at commit `730961cf157d4840b5f5e3619490ec9b2a64fbad` contains conflicting hosted-service claims: [general free/all-chain wording](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/rate-limits.mdx) and a [Base-specific paid-plan requirement](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/base-api.mdx). The later user-supplied DevPortal notice resolves our Base selection: excluded from free access. Older per-instance defaults do not override the notice. The [full API source audit](research/free-api-audit.md) records the historical review and update.
- Direct requests to Etherscan docs/API and Base Blockscout were blocked by this cloud environment's outbound policy. Those failures do not establish provider pricing, key validity, endpoint availability or data completeness. No live source is approved yet.

The external Etherscan repository was read as provider evidence, not installed or invoked as an agent skill. Its procedural instructions do not govern this project.

## Base decision after the screenshot

Do not drop the goal of useful Base coverage merely because an explorer is paid, but do not promise that coverage at zero cost either. Evaluate a free RPC allowance/public endpoint for the actual curated Primus contracts. It must pass quota, history, result-cap and finality/state checks. If it cannot, defer Base and explicitly disclose the coverage gap; independently evaluate another active official Primus mainnet with a verified free explorer. No alternative provider has passed live validation in this session.

For a Base RPC feasibility test, use one approved address/topic and a small block window, hard request timeouts, bounded retries and a durable checkpoint. On timeout/result limit, split the range; stop rather than loop indefinitely if even one block cannot be retrieved completely. Resume from the last fully scanned range, not the maximum returned block. Keep fetched history cached and fetch only incremental ranges with a reorg overlap. Measure the call count and latency against the free quota before accepting the adapter. These controls bound the risk of `eth_getLogs` stalling; they do not guarantee endpoint capacity or unlimited history.

## Adapter requirements

Keep provider-specific HTTP schemas behind an interface for contract logs, transaction/receipt, block metadata, ABI/proxy metadata and optional contract reads. Each adapter declares supported capabilities, plan restrictions, pagination semantics, source watermark and provenance. Normalize into the canonical chain/contract/task model already defined in documents 03–04.

For explorer ingestion:

1. Fetch only the approved contracts and required topics/fields, using a stable block-bounded range where supported.
2. Follow every page/cursor and record scanned coverage, not just the latest returned transaction. A full page at the provider cap is not proof of completeness; split the range or continue as documented.
3. Preserve canonical event identity and deduplicate overlapping retries. Cursor ingestion against a changing index must tolerate newly inserted records and recheck recent ranges.
4. Track explorer-indexed height separately from chain head/finality. Do not label data finalized from an explorer success response alone.
5. Reconcile bounded receipt/log samples and detect source corrections. Retain provider/version and as-of metadata; do not silently merge inconsistent sources.
6. Count daily calls/credits, cache ABI/static metadata and finalized history, and use low-concurrency incremental polling. Honour throttling/Retry-After. Stop or reduce freshness at the free allowance; never silently enable paid usage or rotate keys to evade quotas.

Task requests, per-attestor reports and native outcomes remain different. An explorer log endpoint alone cannot establish `queryTask` state or prove a cryptographic attestation. If a required state read is unavailable free, either use a validated free read route or leave that metric unavailable; do not substitute reports for outcomes.

## Free-source acceptance gate

Before application implementation relies on a provider, record:

- Published free-plan terms plus an actual allowed response for our chain and required endpoints.
- A real contract's bounded history with complete pagination, an event/receipt reconciliation sample and a documented historical boundary.
- Quota/rate/record limits, expected event density, initial backfill call count and daily incremental budget.
- Index lag, available finality/state evidence and behavior for reorgs, missing pages and API error envelopes.
- Key/account requirements and approved host access; API values go only in secure server runtime settings.

If no source passes for a candidate chain, evaluate another official active Primus deployment or reduce the feature/history/freshness scope. Report any inability to meet the free requirement before committing to a paid dependency. Do not call a free architecture validated until these checks succeed.
