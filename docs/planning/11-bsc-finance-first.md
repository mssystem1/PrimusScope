# Current decision: BSC Finance first, Etherscan V2

Decision date: 9 November 2026, Europe/Samara. This supersedes earlier Base-first and Network-beta-first priorities. It does not erase those research artifacts or authorize publication/configuration replay.

Scope clarification: [decision 12](12-ecosystem-scope.md) governs the full ecosystem product. This document selects the first data slice; it does not restrict PrimusScope to the finance dApp.

## Product and chain boundary

The first data slice is the actual **Primus Confidential Finance dApp on BNB Smart Chain, chain ID 56**. Its initial discovery targets are the configured U/eU and USDT/eUSDT routes and their deposit/redeem aggregators. Base work concerned a separate Primus zkTLS Network deployment and is retained as later coverage only.

The first useful public experience should answer: what public protocol activity occurred; what source-backed batch state is observable; which yield/strategy observations are genuinely available; how fresh/complete is the data; and what changed for the public objects a user follows. Wallet Intelligence must add trustworthy context rather than duplicate the portfolio and transaction surfaces already present in the official dApp.

Finance operation counts are not proof counts. Private holdings are not public metrics. Later zkTLS request/report/outcome/attestation tools remain separately named and sourced.

## Chosen data API

Use **Etherscan API V2 with `chainid=56`**, based on the user's confirmation of BSC support on their Free account. The actual key's endpoint access, limits and completeness still need live validation. No paid fallback, key rotation to evade quotas or broad account scraping is enabled.

Live update: the key binding is ready and source metadata for all four aggregators succeeded. `logs/getLogs`, `proxy/eth_blockNumber` and `block/getblocknobytime` returned `FREE_PLAN_CHAIN_UNSUPPORTED` for this key. [Capability evidence](../discovery/bsc-etherscan-capabilities.json) distinguishes working metadata from blocked data operations. No event-history success or zero-activity result is inferred.

The server-side adapter is fixed to `api.etherscan.io`, read-only source/ABI/log/receipt/head operations, bounded requests/time/response size, and explicit pagination. HTTP 200 `NOTOK` is an error, not an empty dataset. The contract registry starts from captured official frontend evidence, then acquires source/ABI/implementation evidence and bounded receipts/logs. No wallet address from the user's screenshot is indexed.

The [BSC source registry](../../scripts/discovery/sources/bsc-finance-source.json) deliberately leaves deployment block, runtime implementation validity and decimals unknown. A shared underlying vault is not counted twice. No `deployBlock:1` full-chain scan is permitted.

## Current configuration

Only one variable is required now: **`ETHERSCAN_API_KEY`**. Create it in Codex's secure environment-variable management, or expose a domain-scoped HTTP secret under that variable name. Do not paste the value into chat or put it in `.env.example`. The scripts read the process environment and do not automatically load `.env` files.

The user has now configured the key securely: observed secret state is `ready`, `api.etherscan.io` is allowed, and actual BSC source requests succeeded. No file edit is required. The earlier automatic draft save failed; the later user-applied settings and successful reads establish current readiness for supported metadata endpoints. The key value is not displayed or retained in repository files. Separate log/block endpoint restrictions remain as recorded above.

Database, worker hosting, Vercel deployment credentials, Base RPC and private SDK credentials are not prerequisites for this discovery phase. The root `.env.example` now separates this one current requirement from commented future variables.

## Build/validation gates

1. Confirm key presence without exposing its value, then a small BSC metadata request with the free account.
2. Resolve the selected aggregator's verified ABI and proxy implementation metadata; compare candidate events before decoding.
3. Use explicit bounded block ranges and follow every page. Missing pages, repeated pages, provider errors and request caps yield partial/blocked outcomes, never fabricated zero activity.
4. Reconcile event/receipt identity; retain only safe batch metadata and sources. Do not expose participant amounts, raw confidential args or inferred hidden values.
5. Validate deployment/history boundaries, finality, units and actual batch semantics. APY history needs its own reliable source; a public reserve total is not confidential TVL.
6. Build one real source → API → UI vertical slice, then expand the validated BSC dashboards, saved views and operational explanations. Deploy and test on Vercel under the existing release plan when the application exists.

The [live Finance review](../discovery/finance-live-source-review.md) records source hashes, discovered routes, current dApp capabilities and remaining integration limits. No production application, private read, funds workflow or published dashboard is claimed complete.
