# Primus Confidential Finance: public-source findings

Current scope: **BSC / BNB Smart Chain mainnet, chain ID 56**. This is the first product/data slice. Base task contracts belong to a separate Primus zkTLS Network integration and are not the chain of the Confidential Finance dApp.

Source retrieval occurred on 8 November 2026 UTC; this report was consolidated on 9 November 2026 in the user's Europe/Samara timezone. No wallet connection, signature, permit, transaction or private account-history query was performed.

## Evidence now available

The official product docs, architecture docs and public frontend assets are accessible with normal proxy and system TLS verification. The active workspace independently downloaded the following resources and checked their hashes:

| Resource | URL | SHA-256 |
| --- | --- | --- |
| Product docs | https://docs.primuslabs.xyz/fhe/confidential-finance-product/ | `3ba231537a1128d87314b6163e59c59bef72d2273dc7cbcb168c1992159cb921` |
| FHE architecture | https://docs.primuslabs.xyz/fhe/overview/ | `5c7dce7227db9a0af90cef8055c36bfdd20aa84cc51ff2e1178430c93cee2fc7` |
| Privacy vault | https://docs.primuslabs.xyz/fhe/use-cases/privacy-vault/ | `f57e152eb8f31bb10337b68e9a2e501df98352cf5f3aa6428af7a9ea0e2a931b` |
| Mainnet config | https://dapp.primuslabs.xyz/_next/static/chunks/4781-1070ecc68618aa01.js | `c93d64c0e72a2282d32206ee6130462cb5ddf0b258608b40651ed664366baf1e` |
| State/client logic | https://dapp.primuslabs.xyz/_next/static/chunks/4527-ba3058e1f0511770.js | `526000f11d7c6a56a4f955fc0ae53bfcbbfd689d70249d5031da05b477ca9882` |
| Yield adapter | https://dapp.primuslabs.xyz/_next/static/chunks/1531-d4befecc0fcfd5aa.js | `cd22c8aaf94a8812c9e5bcdd2f0aa0557d1c0c1b1b6e187f4ed7332470cafd9c` |

Ignored snapshots and manifest: `.local/research/bsc-public-sources/`. Asset URLs are point-in-time evidence, not supported permanent APIs. Their public configuration is not deployed-code approval.

## Concrete BSC discovery registry

The [machine-readable source registry](../../scripts/discovery/sources/bsc-finance-source.json) records two `visible/enabled` mainnet routes:

| Route | Confidential token | Deposit aggregator | Redeem aggregator |
| --- | --- | --- | --- |
| U / eU | `0x3EcB7d91C98ca4B4924e0CC5Eca7472b21F06800` | `0xedcDd426f7690c7Da365f8E9BE0C396353e5dd24` | `0xBef1366512ffFF33cdd6C48d66e48D33c6dbCa22` |
| USDT / eUSDT | `0xc2CC9419DDEb3425876091a1eb79D5C59017838c` | `0xE76F5202EF8eEB462eC784Fe51D69E9a8a0b56c1` | `0x485dBFD90DdF92E009438FF49b1918C6636a8f89` |

Both routes reference underlying vault `0xe9E8573Bb351da16c6EE7dDaC0cBC70b7f9784AE`. The encrypted position-token addresses are `0x06776741b1f8bfF5ea51750E91edcf03ed8C6994` for U and `0x75787E2aBEE0ddaa747Eee5F0f4Ff58dB142354d` for USDT. Underlying token addresses and source hashes are in the registry.

These are **official frontend configuration observations**. Actual deployment blocks, proxy histories, ABIs, on-chain decimals/rates, live operational states and source reuse terms still require validation. The frontend's `deployBlock:1` is deliberately not accepted as deployment evidence. Shared strategy totals cannot be counted once per route or labelled Primus confidential TVL without reconciliation and disclosure review.

## Native lifecycle and yield candidates

Shipped frontend code maps aggregate states to `open`, `dispatched`, `finalized`, `canceled`. Unitas steps include `none`, `mint_init`, `mint_await_output`, `redeem_init`, `redeem_cooldown`, `redeem_await_output`. Candidate events include `AggregateDispatched`, `AggregateFinalized`, `AggregateCanceled`, `StepAdvanced` and `Recovered`.

The Etherscan probe must match those signatures against the fetched verified ABI before projecting any batch identifier or timeline. Batch finalization is not proof every participant claimed. No generic Queued/Processing/Claimable animation, guessed cooldown or amount-derived progress is justified.

The official frontend calls `/proxy/unitas/usdu/stats`, consuming fields such as `avg_apy`, `vault_usdu`, `total_backing`, and has separate incentive presentation logic. A parallel read-only request returned HTTP 403 with `error code: 1010`. No current value, historical APY series or stable authorized feed was validated. This is a remote-response observation, not evidence that a paid API or private wallet credential is required. Do not turn the UI's numeric bonus arithmetic into a financial definition or use backing figures as confidential user TVL.

## Existing dApp features and differentiation

The public bundles contain portfolio, activity, shield/send/unshield and vault flows. They also contain scoped `permitService.signDecryptionPermit` calls and private-balance hooks. The user's connected-portfolio screenshot corroborates existing portfolio/token/transaction surfaces. Its wallet address and balances are not discovery inputs.

Consequently, "a portfolio exists" is not a unique PrimusScope proposition. Useful differentiators to validate are historical public protocol analytics, batch-state explanations, published yield history with methodology, source health, saved monitoring views and a separately scoped proof/task explorer. Authenticated dApp functionality has not been exhaustively compared, so no broad missing-feature claim is justified.

An internal bundled permit method is not evidence of a supported distributable FHE owner-read SDK. The Fund SDK remains a separate social-account funding product. Private positions require an official supported integration; no decryption material, plaintext balance or private history enters this public pipeline.

## Trust and rendering boundaries

Official architecture docs describe current KMS key isolation in a TEE, with threshold MPC as future evolution. Do not claim current production owner reads already use decentralized threshold MPC, or that zkFHE research establishes independent proof verification of current finance operations.

A parallel review attempted direct Playwright rendering and encountered `ERR_CERT_AUTHORITY_INVALID`. Automatic approval review rejected a persistent import of the proxy CA into the browser trust store; no such import executed. A safer limited rendering used public GET/HEAD resources fetched with normal system TLS verification and browser request interception, without trust changes or disabled verification. Other hosts, POST, WebSockets and service workers were blocked.

That partial anonymous rendering showed a wallet-connect landing page on `/` and `/vaults`, not a normal-network authenticated workflow. Screenshots were generated in the prior executor and were not migrated into this workspace; they are not linked as current artifacts. This does not prove the full dApp lacks analytics or that direct browser TLS now works. The current workspace's retained primary evidence is the verified public source snapshots above.

## Immediate validation sequence

Live Etherscan update: [source observations](bsc-first-source-observation.json) plus [the other three aggregators](bsc-other-source-observations.json) resolve current explorer-reported implementations and ABI fingerprints. The proxies share two implementation source contracts, and all four ABIs contain the five candidate batch event signatures. This improves source evidence but does not independently establish deployed bytecode, historical implementation intervals or event history. [Data endpoint probes](bsc-etherscan-capabilities.json) returned free-plan unsupported for logs/block operations.

1. Use the user's Etherscan Free key against chain 56; first source/ABI metadata, then a bounded paginated contract-log sample.
2. Resolve proxy implementations and historical ABI boundaries; do not mark runtime compatibility approved from a frontend address alone.
3. Reconcile public batch event identities with receipts. Exclude participant fields, amounts, reserve differencing and private-wallet joins from reports.
4. Obtain actual deployment/coverage boundaries, units and getter semantics before any full-history chart.
5. Treat published APY history and owner-private reads as separate source/integration gates. Etherscan events alone do not establish either.
