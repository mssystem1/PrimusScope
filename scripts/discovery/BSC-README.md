# BSC Finance discovery — current workflow

**Working hybrid path:** [the bounded RPC helper](bsc_rpc_probe.py) reads BSC events/receipts without another key, using the verified-source evidence recorded by Etherscan. See [live readiness](../../docs/discovery/DATA_READINESS.md). Run `python scripts/discovery/bsc_rpc_probe.py` for a new bounded recent sample, or use the exact example range in that report to exercise checkpoint resume. The Etherscan-only helper below remains useful for supported metadata operations.

This is the current discovery path: **Etherscan V2, BNB Smart Chain, chain ID 56**. Base utilities in this directory are separate historical zkTLS Network research and are not required here.

Current live evidence: the key is securely configured and metadata for four aggregators succeeded. The account's `logs/getLogs`, `proxy/eth_blockNumber` and `block/getblocknobytime` requests returned `FREE_PLAN_CHAIN_UNSUPPORTED`. See [the per-endpoint capability report](../../docs/discovery/bsc-etherscan-capabilities.json). Do not mistake working contract metadata for working event history or retry a plan-gated endpoint unchanged.

## One current configuration requirement

Create **`ETHERSCAN_API_KEY`** in Codex's secure environment-variable management. Alternatively expose a domain-scoped HTTP secret under that same variable name. Add **`api.etherscan.io`** to the existing additional allowed domains.

The key must come from the user's Etherscan account with BSC access. Free-plan support was confirmed by the user; actual endpoint entitlement and limits remain to be validated by a small authenticated read. The discovery code never upgrades a plan or rotates keys to evade quotas.

The root [.env.example](../../.env.example) is only an empty template, not the active cloud variable store. This probe reads the process environment and does not load `.env` files. No database, Base RPC, Vercel token, wallet key or private decryption credential is needed for this phase. Do not paste the key into chat or commit it in a template.

## Commands

From `/workspace/PrimusScope`:

```bash
python -m unittest discover -s scripts/discovery/tests -v
python scripts/discovery/bsc_etherscan_probe.py
python scripts/discovery/bsc_etherscan_probe.py --route usdt --role redeem
```

Default mode inspects one configured aggregator's verified-source metadata and, where reported, one implementation address. No log range is assumed and no full-history scan starts. The registry's deployment block is unknown; the frontend's `deployBlock:1` is not used.

Only after source/ABI/history checks, supply both `--from-block` and `--to-block` for a known bounded interval. Trials allow at most 10,000 blocks, five pages and twenty requests, with a hard per-request deadline and paced starts. Default log page size is 1,000, subject to current actual provider limits. Exact full pages require another page; a page budget, duplicate page or provider error produces partial coverage.

The probe resolves candidate batch event signatures against the returned verified ABI before projecting data. It retains event identity, public batch ID where the ABI confirms its location, and a receipt sample. It does not retain participant fields, token amounts, exchange rates, raw source code, full ABI responses, decryption permits or wallet histories. ABI/source fingerprints and provider observations are not independent deployed-code or publication approval.

## Outcomes and limits

- `metadata_observed_logs_not_requested`: metadata was observed, with no claim that a lifecycle/history passed.
- `bounded_batch_sample_observed`: a bounded event sample was observed; provider completeness, historical ABI validity, finality and economic semantics still need independent review.
- `bounded_sample_empty`: no matching batch events in that interval, not no Primus activity.
- `partial` / `blocked`: retain the safe reason and request ledger; never replace an error with zero.
- Missing key: stop before network access and write a sanitized blocked report.

Reports go to ignored `.local/discovery/bsc-etherscan-*.json`. Keys remain out of argv, reports and errors. Etherscan `NOTOK`, invalid key, unsupported plan, throttling, unverified source and malformed responses are distinct failures. Requests are read-only; no redirects, automatic retries, paid fallback or signing operations are enabled.

This is an initial feasibility helper, not a production indexer. Scheduled ingestion, durable historical checkpoints, source finality, ABI upgrade history, units, APY feeds, privacy/publication policy and database/web serving remain later gates. See [the current BSC decision](../../docs/planning/11-bsc-finance-first.md) and [live Finance source review](../../docs/discovery/finance-live-source-review.md).
