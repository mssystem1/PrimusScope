# BSC finance data sources — selected route and evidence

Review date: 8 November 2026. Current workspace: the new `a0b9be61…` environment. Read-only provider/source research; no RPC requests, credentials, configuration changes or publication occurred in this subtask.

## Current decision

The user confirms their **Etherscan Free plan supports BNB Smart Chain**. Use **Etherscan API V2, chain ID 56**, as the primary candidate for Primus Confidential Finance logs, transactions and verified-contract metadata. Treat this as user-confirmed account eligibility; authenticate a small actual read before describing the integration as live-validated.

Do not continue debating Base coverage or require a paid provider. Base zkTLS task contracts are separate from the BSC Confidential Finance dApp. No BSC data has been fetched by this research subtask.

## Etherscan request contract

Official `etherscan/skills` source inspected at commit [`91f96cf42c4e4300c7e1a24314588d1454dd47d1`](https://github.com/etherscan/skills/tree/91f96cf42c4e4300c7e1a24314588d1454dd47d1):

- [API V2 guidance](https://github.com/etherscan/skills/blob/91f96cf42c4e4300c7e1a24314588d1454dd47d1/skills/etherscan/references/api.md) establishes `https://api.etherscan.io/v2/api`, explicit `chainid`, and provider error-envelope handling.
- [Transport reference](https://github.com/etherscan/skills/blob/91f96cf42c4e4300c7e1a24314588d1454dd47d1/skills/etherscan-flow/references/transports.md) corroborates contract ABI/source, event-log pagination, receipt and supported contract-read operations.

| Need | API family | Required handling |
| --- | --- | --- |
| Contract logs | `module=logs`, `action=getLogs`, chain 56, registered address, bounded blocks/topics, `page` and `offset` | Follow all pages; source guidance gives offset at most 1,000, but actual current endpoint limits need validation. Split capped ranges; never treat truncation as zero or complete history. |
| Verified ABI | `module=contract`, `action=getabi` | Pin exact source/ABI hash and proxy implementation validity; explorer verification is not security approval. |
| Contract metadata | `module=contract`, `action=getsourcecode` | Preserve proxy/source version evidence; do not infer current implementation compatibility from address alone. |
| Receipt | `module=proxy`, `action=eth_getTransactionReceipt` | Reconcile transaction/block/log identity with indexed events; preserve fee components and units. |
| Public contract getter | Supported proxy `eth_call` route, if available for the account | Validate supported tags/history; safe minimal projection only, not raw confidential/attestation payload storage. |

Read `status`, `message` and `result` according to the endpoint response model. HTTP 200 alone is not success. Authentication, plan restrictions, throttling, malformed parameters and no matching events are separate outcomes. Keep API keys in secure server runtime configuration; omit them from logs, command arguments and frontend bundles.

Live Etherscan documentation and API access have not been exercised here. A competitor's chain-comparison table is not authoritative pricing evidence and must not override the user's account report. Actual free-key reads settle endpoint access and quotas.

## Why the default BNB public RPC is not a log-indexing fallback

Official BNB documentation at commit [`83ba55529bbeeec7afe1ac80e649ab4967addc25`](https://github.com/bnb-chain/bnb-chain.github.io/tree/83ba55529bbeeec7afe1ac80e649ab4967addc25) explicitly states:

> “eth_getLogs is disabled on below Mainnet endpoints”

Source: [BSC JSON-RPC endpoints](https://github.com/bnb-chain/bnb-chain.github.io/blob/83ba55529bbeeec7afe1ac80e649ab4967addc25/docs/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint.md). Listed endpoints include `bsc-dataseed.bnbchain.org`, `bsc-dataseed-public.bnbchain.org`, and others. The page states a 10K/5min rate limit. These are documentation observations, not a live quota measurement.

Those nodes remain candidates for supported small code/state/finality reads, but must not be treated as a keyless historical `eth_getLogs` service. The [BSC API document](https://github.com/bnb-chain/bnb-chain.github.io/blob/83ba55529bbeeec7afe1ac80e649ab4967addc25/docs/bnb-smart-chain/developers/json_rpc/bsc-api-list.md) documents `safe`/`finalized` tags and chain-specific fast/probabilistic finality. Its timing examples are not measured current chain performance.

`bsc-rpc.publicnode.com` appears in public chain registries, but a registry listing does not establish its current terms, log support, quota or historical completeness. No suitable primary Allnodes service commitment was located in this bounded review. It is not an approved fallback.

## Optional managed-RPC evidence, not a new requirement

Official `alchemyplatform/docs` at commit [`08893679ddf279ebd5930e322258ee83bbcdf2aa`](https://github.com/alchemyplatform/docs/tree/08893679ddf279ebd5930e322258ee83bbcdf2aa) contains:

- A [BSC quickstart](https://github.com/alchemyplatform/docs/blob/08893679ddf279ebd5930e322258ee83bbcdf2aa/content/api-reference/bnb-smart-chain/bnb-smart-chain-api-quickstart.mdx) offering a free key and endpoint pattern `https://bnb-mainnet.g.alchemy.com/v2/<key>`.
- A [pricing table](https://github.com/alchemyplatform/docs/blob/08893679ddf279ebd5930e322258ee83bbcdf2aa/content/api-reference/pricing-resources/pricing/pricing-plans.mdx) listing 30,000,000 base compute units, 300 CU/s and Node API/archive availability on Free.
- The [shared method specification](https://github.com/alchemyplatform/docs/blob/08893679ddf279ebd5930e322258ee83bbcdf2aa/src/openrpc/chains/_components/evm/methods.yaml) limits free `eth_getLogs` queries, including BNB, to **10 blocks**, with a listed cost of 60 CUs. These constraints can make broad historical backfill expensive even at $0 spend.

This is a source-supported backup option, not a requested account, proven live integration, unlimited allowance or reason to replace the selected Etherscan path. No credentials were requested and no managed endpoint was called.

## Next validation

Use the securely configured user's Etherscan Free key for a small BSC read: verify a curated finance contract's ABI/source metadata and a bounded log range, then exercise pagination. Record actual endpoint access, caps, quota/Retry-After, source lag and historical boundary before scaling ingestion. Verify runtime code/proxy and safe finance metric projections separately. No private wallet histories, permits or balance reconstruction are part of this public-data test.
