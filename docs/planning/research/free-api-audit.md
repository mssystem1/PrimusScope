# Free API feasibility: explorer-first PrimusScope

Research date: 8 November 2026. Read-only official documentation/source review. No provider key was requested or supplied, and no production data integration was tested. Direct `base.blockscout.com`, `api.etherscan.io` and `mainnet.base.org` requests were denied by this environment's destination policy (proxy tunnel 403), so this is not a live finding that the provider itself rejects/free-allows those endpoints.

**Subsequent user evidence:** the attached Blockscout DevPortal screenshot states Base, Polygon and ZkSync were removed from Free tier starting October 1, 2026. This resolves the Base uncertainty described in the original review below: hosted Blockscout Base is excluded from our $0-data plan. Retain the documentation conflict as research history, not as grounds to keep considering Base free access.

## Recommendation

Use an explorer-first acquisition adapter for ABI/source metadata, paginated contract logs, transactions and receipts. This can substantially reduce the operational burden and sparse-chain scanning costs of wide `eth_getLogs` requests. Persist/canonicalize the results locally and serve dashboards from the database/cache rather than sending each visitor's query to a provider. Keep the ingestion engine provider-neutral.

Do not designate Base or any paid service as a required dependency under the user's free-data requirement. Select the first active Primus mainnet that passes a free-tier capability/coverage test. Public availability of a website is not evidence of a permanently free programmatic API. If a source needs a key on its free tier, configure that securely; “free” and “keyless” are different conditions.

Use a small bounded number of public read-only RPC calls only for essential state/identity checks not furnished by the chosen free explorer: `eth_chainId`, deployed bytecode/implementation, pinned `queryTask` reads, chain safe/finalized head if supported. Some explorer products provide `eth_call` themselves, but that does not make state reads unnecessary or guarantee archive state access. If no free source supports a required read, explicitly narrow the feature or mark its state unknown; do not infer task success.

## Authoritative Blockscout sources and conflict

All links below pin official `blockscout/docs` commit `730961cf157d4840b5f5e3619490ec9b2a64fbad`, fetched in this session.

| Source | What it actually states | Consequence |
|---|---|---|
| [Base API page](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/base-api.mdx) | “Base API access requires a paid plan”; lists Builder $49/month as first tier and instructs purchase. | Cannot promise free hosted Base API based on generic free tier. |
| [Rate limits](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/rate-limits.mdx) | Free tier 5 RPS / 100K credits per day / $0, describes all chains. Standard calls cost 20 credits; address logs and transaction logs cost 30. API key required. | Conflicts with Base page. Free budget is roughly 5,000 standard calls or 3,333 log calls daily if all credits are spent on that class, not 100K requests/day. Current account/chain capability must be verified. |
| [General API](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/devs/blockscout-api.mdx) | Unified multichain API, free key, all-chain language; current chain list linked to backend config. | A listed chain indicates supported product coverage, not resolution of conflicting plan eligibility. |
| [Requests and limits](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/devs/apis/requests-and-limits.mdx) | Warning: per-instance API will be deprecated July 1 (warning does not specify year). Describes no-key 300 requests/minute per IP as configurable software default. | Do not design around permanently keyless `base.blockscout.com/api/v2`. Default server software limits are not hosted service guarantees. |
| [Migration guide](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/devs/migrate-from-etherscan.mdx) | Chain table marks Base as paid-only on Etherscan while listing Blockscout free; elsewhere promotes unified key and free tier. | This third-party comparison is not authoritative Etherscan pricing and also conflicts with Blockscout Base page. Verify official Etherscan free-chain eligibility before selecting it. |

The rates page explains that public explorer hosts can also present bot challenges and recommends unified keyed API for programmatic access. This environment's proxy 403 is a separate observed restriction; do not confuse it with that documented bot protection.

## Pagination and endpoint capabilities confirmed in official spec

[Official REST OpenAPI](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/openapi-specs/openapi.yaml) defines:

- `GET /api/v2/addresses/{address_hash}/logs` — log items plus `next_page_params`, example cursor fields `block_number`, `index`, `items_count`.
- `GET /api/v2/addresses/{address_hash}/transactions` — transaction items plus cursor; supports `filter=to|from`.
- `GET /api/v2/transactions/{transaction_hash}/logs` — transaction logs plus cursor.
- `GET /api/v2/smart-contracts/{address_hash}` — smart-contract metadata.

Follow the returned cursor unchanged; checkpoint pages, reject repeated cursor loops, retain overlap around the last durable high-watermark, and deduplicate by canonical event identity. Do not assume a short page means complete history if the service returns a cursor. Confirm actual instance API version: official docs note v12 breaking changes beginning October 2026.

[Logs module docs](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/devs/apis/rpc/logs.mdx) describe Etherscan-compatible `module=logs&action=getLogs` with address/topics/block ranges and a maximum 1,000 returned logs. A capped response is not proof that the block window was completely scanned; split windows or use a supported complete pagination mode. This API is often easier to consume than raw node log scans, but does not eliminate pagination/completeness engineering.

[ETH RPC docs](https://github.com/blockscout/docs/blob/730961cf157d4840b5f5e3619490ec9b2a64fbad/devs/apis/rpc/eth-rpc.mdx) include `eth_call`, block hashes, code, receipts and logs. Unified API requires a key. Per-instance no-key route is documented, but its continued availability/limits remain subject to the deprecation and host policy above. An explorer's transaction list and logs alone cannot supply arbitrary current or historical `queryTask` results.

## Free-tier acceptance gate before selecting a chain/provider

1. Verify provider's official free-plan eligibility for this exact chain, endpoint and commercial/public analytics use. No credit-card dependency unless user separately chooses one.
2. Fetch official Primus task ABI/source metadata and at least one real request/report pair. Compare with official SDK ABI and native task state where a free read exists.
3. Exercise at least two pages of logs/transactions, prove cursor termination, test overlap/deduplication, establish deploy-to-head coverage or clearly bound available history.
4. Establish a quota budget: initial backfill separately from steady-state updates; all contracts/chains share the same keyed quota. Poll only curated contracts, cache immutable finalized history, cap retries and pause with a stale indicator before exhausting budget.
5. Test 429/backoff, daily quota exhaustion, provider timeout, malformed/HTML response, result cap, indexer lag and provider schema drift. No silent switch to paid endpoints or an empty zero dashboard.
6. Retain chain/block/hash/source/version metadata. Explorer results are provider observations; do not label them independently chain-finalized unless the finality policy has evidence. Replay an overlap window to detect corrections/reorgs and invalidate affected derived totals. If a provider cannot provide complete history/hash reconciliation, expose partial coverage and gate exact historical rates.
7. Test `queryTask` status against multi-attestor and partial-success examples. On-chain report count, callback failure and wallet transaction success are each different from proof validity/task success.

Public RPC is a fallback capability, not a requirement to operate our own node or pay for a managed RPC plan. Conversely, using a free API does not remove runtime hosting, storage or reliability costs. Data-API spend can remain zero by fitting the validated quota and reducing supported coverage/cadence; do not promise unlimited analytics capacity at zero cost.
