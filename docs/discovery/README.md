# Base RPC feasibility: execution evidence

**Current scope has moved to BSC Confidential Finance via Etherscan V2.** See [the BSC runbook](../../scripts/discovery/BSC-README.md), [Finance source findings](finance-live-source-review.md) and [current decision](../planning/11-bsc-finance-first.md). The Base evidence below is historical; it does not determine the finance dApp's chain or current configuration needs.

Date: 8 November 2026. User-selected path: Base using bounded free RPC; no paid explorer or RPC plan.

The [executable probe](../../scripts/discovery/README.md), sanitized scanner and pinned official-source ABI subset are implemented. This is discovery tooling; the PrimusScope web application, database worker and Vercel deployment are not implemented by this task.

## Actual live attempt

Command from `/workspace/PrimusScope`:

```bash
python scripts/discovery/base_probe.py --max-requests 30 --timeout 10 --max-run-seconds 90
```

Recorded outcome: **blocked**, exit 2, `PROXY_TUNNEL_DENIED`, one attempted `eth_chainId` request to `mainnet.base.org`. The curl-measured proxy CONNECT status was 403. It stopped in approximately 0.02 seconds without retrying, scanning or switching providers.

The [saved sanitized report](base-rpc-blocked-20261108.json) records source version, bounds, elapsed time and the safe request ledger. No endpoint key or chain payload appears in it. A proxy denial is not evidence that the Base RPC is slow, unavailable, paid or lacks history.

**No live chain ID, contract code, logs, receipts, task status, archive capability, provider quota or finalized-chain semantics were validated.** Free-data feasibility and a real task lifecycle remain unproven. The source ABI/address are documented official-source seeds, not approved deployed compatibility.

## Independent work completed

- Source-pinned ABI/events/read selectors from the official Primus Network SDK, with integrity hashes and runtime-unverified status.
- Hard per-request timeout, request/response-size bounds and a run budget.
- Adaptive range splitting; gaps and capped singleton responses stop safely.
- Atomic scoped checkpoints and boundary-hash checks on resume.
- Receipt/task-ID reconciliation and minimal native-state projection; task status remains separate from cryptographic proof validity.
- Offline tests for wrong chain, malformed responses/ABI state, request limits, quota/TLS/access failures, dense ranges, duplicate/reordered logs, gaps, checkpoint corruption/reorg and diagnostic redaction.

Run the current offline suite with `python -m unittest discover -s scripts/discovery/tests -v`. Its passing result demonstrates local behavior against synthetic fixtures, not live provider readiness. Test counts and exact current outcome are recorded in the task report rather than inventing a live pass.

## Required action to continue live validation

Allow the exact HTTPS hostname **`mainnet.base.org`** in this cloud environment's outbound network settings. No API key is needed for the first endpoint. Existing rules must be retained. The environment configuration service could not load the editable draft, so no rule update was safely saved/applied from this task.

After access changes, refresh observed environment status and rerun the command with a fresh process. Do not repeat unchanged denied requests. If the endpoint is reachable, verify the bounded sample first; widen to another explicitly bounded range only after a meaningful observation. If no real task appears, report that narrow result, not no Primus usage.

Next gates after reachability: current code/proxy/ABI compatibility, a real request/report/native-state sample, complete-history feasibility and historical state access, actual free allowance/request budget, Base finality policy and privacy-safe publication. Only then start the application/indexer vertical slice.
