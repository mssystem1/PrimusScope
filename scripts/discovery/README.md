# Base free-RPC discovery utility

**Current product priority is BSC Finance through Etherscan V2.** Use [the BSC runbook](BSC-README.md). This Base utility is retained for the separate zkTLS Network research track; no Base variable or provider is required for current discovery.

This is a dependency-free research tool, not the application or a production indexer. It exercises path 1 selected by the user: Base, read-only, with no paid data API. Requires Python 3.12+ and curl with `--max-filesize` support (validated locally with curl 8.14.1).

From `/workspace/PrimusScope`:

```bash
python -m unittest discover -s scripts/discovery/tests -v
python scripts/discovery/base_probe.py --max-requests 30 --timeout 10 --max-run-seconds 90
```

The script reads `BASE_RPC_URL` from the process environment or defaults to the keyless official public endpoint `https://mainnet.base.org`. It does not load `.env` files automatically. Use secure runtime settings for credential-bearing provider URLs; never supply them in command-line arguments or paste them into diagnostics. Existing proxy variables and CA verification remain in force; redirects are not followed.

No Primus app secret, wallet/signing key, explorer key, database or deployment credential is required. `BASE_RPC_FALLBACK_URL` is not automatically used: a policy/access failure does not trigger endpoint rotation.

## What it does

1. Verify chain ID 8453, read head and provider-reported finalized block, and pin a bounded target.
2. Check contract code and observe the standard EIP-1967 implementation slot without claiming every proxy uses it. Fingerprint returned code with explicitly labelled SHA-256, not Ethereum code-hash semantics.
3. Load the official-source pinned ABI subset and filter four recognized task events. Scan only a bounded recent range; split ranges on known time/size failures. HTTP access, TLS and quota errors stop rather than trigger a retry storm.
4. Validate/deduplicate returned event metadata. Only explicitly mapped events yield a task ID from their first nonindexed word. Discard remaining event data and subject fields from reports/checkpoints.
5. Reconcile a small receipt sample, including the projected task ID. Project only status/submission time from one block-pinned `queryTask` result, if a task was observed. No proof validity is inferred.
6. Recheck the pinned target hash and write a sanitized outcome/request ledger.

The source registry is explicitly runtime-unverified. No deployment block or historical ABI validity range has been established. Full `queryTask` attestation results, template strings, account subjects, calldata and complete event data are never included in persistent reports/checkpoints. curl uses private temporary request/response files, cleaned on exit; no sensitive real-user proofs should be supplied to this tool.

## Bounds and checkpoint semantics

Defaults: 1,000 blocks, initial 100-block ranges, maximum 40 attempted requests, 10-second request timeout, 90-second run budget and 2 MB response cap. CLI upper bounds: 10,000 blocks per trial, 100 requests and 300 seconds. A checkpointed successful range uses a log request plus a boundary-header request; include both in the budget. Known size/time failures shrink the range. A single-block failure or possible capped response is a gap, not a success.

Runs and checkpoints are under ignored `.local/discovery/`. Endpoint paths/keys and raw provider errors are absent from diagnostics. Reports contain only the endpoint hostname. Checkpoints bind chain/source/ABI, provider host, exact range and target hash; resume validates the stored boundary hash and rejects mismatched/tampered checkpoints.

**Rerunning defaults selects a new recent sample; it does not automatically resume an older window.** To resume a partial trial, use the exact previous report's `requestedRange.fromBlock` and `toBlock` as `--from-block` and `--to-block`, preserving the other source settings. A changed target hash creates a new scope; mismatched boundary history is rejected. Run one probe at a time; this is not a multi-worker lease implementation.

Request budgets are per invocation. No scheduled retries, paid fallback or unbounded backfill is enabled. A production daily allowance/scheduler and full reorg/finality policy remain later work once the endpoint's actual capabilities and service terms pass validation.

## Outcomes

| Exit | Outcome | Meaning |
| --- | --- | --- |
| 0 | `bounded_sample_observed` | Events and supported sample checks observed; not production or full-history approval |
| 2 | `blocked` | Configuration/access/identity prevented the probe |
| 3 | `partial` | Gap, budget, inconsistent response or incomplete enrichment; preserve trustworthy checkpoint |
| 4 | `bounded_sample_empty` | No matching events in this range; task lifecycle and global usage remain unknown |

`scan.complete` means every requested bounded range returned structurally valid data; it is **not independent proof that the provider omitted nothing**. Provider `finalized` tags are recorded as reported evidence; reviewed Base/L1 settlement semantics and provider correctness are not established merely by one response.

Current actual result and next external requirement: [feasibility evidence](../../docs/discovery/README.md).
