# Current data foundation: live validation

Validated 9 November 2026, Europe/Samara. Product scope remains the full Primus ecosystem; the observations below validate separate Finance and zkTLS Network source slices. No environment settings were reapplied and nothing was published or deployed by this task.

## Environment

The new attached environment reports public Internet access **unrestricted and enforced**. The existing `ETHERSCAN_API_KEY` binding is ready and remains destination-scoped to `api.etherscan.io`. All project files survived publication/restoration. No additional key, account or environment-variable change was required for the successful RPC trials.

## Working $0 source arrangement

| Data | Validated source | Actual result |
| --- | --- | --- |
| BSC Finance contract/source/ABI metadata | Etherscan V2, chain 56 | Four aggregators resolve to two explorer-verified implementation sources; ABI fingerprints retained |
| BSC Finance events, receipts and public state | `https://bsc-rpc.publicnode.com` | Keyless requests accepted; batch events and a native finalized state reconciled |
| Separate Base zkTLS Network events/state | `https://base-rpc.publicnode.com` | Keyless request/report sample and native task state reconciled |

These sources required no paid plan for the observed calls. This is not a promise of unlimited quota, permanent service availability or an SLA. Provider limits remain monitored; timeouts reduce ranges, and gaps/rate/access errors remain explicit.

Later incremental-worker validation found an operation-specific limit: BSC
historical `eth_getCode` at the retained seed returned HTTP403 with a JSON-RPC
archive restriction, reproduced by both transports. Event/block availability
must therefore be distinguished from archive-state availability. The local
worker uses an explicit retained-evidence/finalized-target event policy with
upgrade monitoring; it does not claim independent historical code/ABI checks
at every event block. See [the local indexing policy](../LOCAL_INDEXER.md).

Etherscan's BSC logs/block/creation operations still returned a free-plan restriction for this key. That limitation has not been bypassed. The working arrangement keeps Etherscan for supported metadata and uses a separate public RPC for chain data. No Etherscan credential is read or sent by the RPC helper.

## BSC Finance: observed sample

- Chain ID verified as **56**.
- Scope: blocks **132,495,502–132,545,501**, the four configured U/eU and USDT/eUSDT aggregators, and five recognized batch-event signatures.
- Source block timestamps cover **05:20:18–11:35:25 on 9 November 2026, Europe/Samara**. This is approximately six hours and fifteen minutes, not full history.
- Nine recognized events: three `StepAdvanced`, three `AggregateDispatched`, two `AggregateFinalized`, one `AggregateCanceled`.
- Four contract/batch groups appeared in the sample. No individual confidential-finance wallet history was collected.
- Route breakdown: U/eU has two events in one canceled batch; USDT/eUSDT has seven events across three batches. Only the U redeem aggregator has no recognized events in this window; this is not a zero-activity statement for the entire U route.
- All nine event identities were found in their transaction receipts. Pinpoint log requests additionally matched the selected complete dispatch/finalization pair.
- EIP-1967 slot reads for all four proxies matched the explorer-reported implementation addresses at pinned block 132,545,501.
- Public `currentAggregateId` reads succeeded. These values identify current open aggregates; they are not settled-batch or user counts.
- USDT deposit aggregate **146** had native state code **2 (Finalized)** at the pinned block. Its source-block dispatch-to-finalization interval was **55 seconds**. This is one batch observation, excluding private queuing and user claim time; it is not a network-wide latency benchmark.

The provider accepted an initial 50,000-block log request in about 5.25 seconds. A second large request timed out at the enforced ten-second deadline. The executable helper therefore defaults to 10,000-block chunks and adaptively shrinks known time/size failures instead of waiting indefinitely.

Evidence:

- [Bounded scan and source checks](bsc-rpc-observation.json): 26 requests, nine events, completed requested scope.
- [Checkpoint resume](bsc-rpc-resume-observation.json): same nine events, 15 validation requests, **zero log re-fetches**.
- [Receipts, proxy slots and native-state sample](bsc-native-observation.json): 23 requests; safe public projections only.
- [Exact sampled-range timestamps](bsc-window-observation.json), used by the application importer rather than the provider's newer finalized head.
- [Read-method semantics](bsc-read-methods.md) and [read-only getter fixture](../../scripts/discovery/sources/bsc-read-methods.json).

`complete` means the requested bounded provider ranges returned and passed structural/consistency checks. It does not independently prove the provider omitted nothing. The endpoint's finalized tag is recorded as provider-reported evidence, not an independent consensus proof.

## zkTLS Network: separate Base sample

The [network observation](network-free-rpc-observation.json) and [review](network-free-rpc-observation.md) record a separate ten-call trial over 10,000 blocks:

- 223 recognized events: **116 requests, 90 attestor reports, 17 withdrawals**.
- A selected task had both a request and report in scope. Receipt identity/task ID reconciliation passed.
- A pinned `queryTask` projection returned native **SUCCESS**.
- Attestation cryptographic verification was **not run**.

Those counts are different event populations. Do not divide the report count by the request count to produce a completion rate, label them global Primus usage, or call them verified proofs. Contract-mode coverage does not include every SDK/off-chain workflow.

## Reproducible commands

From `/workspace/PrimusScope`:

```bash
python -m unittest discover -s scripts/discovery/tests -v
python scripts/discovery/bsc_rpc_probe.py --from-block 132495502 --to-block 132545501
```

Repeat the exact range with the same source evidence to resume its checkpoint. Rerunning the default recent-window command selects a new sample rather than continuing an old one. The helper is bounded discovery tooling, not a scheduled production indexer.

The current offline suite has **114 passing tests** after the creation-metadata adapter checks. Tests cover transport safety, request budgets, pacing, malformed responses, dense range splitting, gaps, source/implementation mismatch, checkpoint resume/reorg, safe projections and receipt/batch identity. Offline fixture passes are distinct from the live observations above.

## Decisions now supported

1. Prepare independent Finance and Network adapters behind shared provenance/status/API contracts.
2. BSC public batch timelines and correctly scoped event counts have a demonstrated real-data path. Batch state can be explained without publishing amounts, exchange rates or participant graphs.
3. Network request/report/native-state exploration has a demonstrated real-data path, separate from cryptographic attestation checks.
4. Cache source metadata, fetch only incremental bounded ranges, and preserve source versions/watermarks before creating dashboards. Device-local watched public objects can use the same identities.
5. Developer Studio remains an explicit opt-in SDK workstream; these public-chain observations are not developer telemetry or a census of SDK reliability.

## Remaining launch gates

- **Full history:** actual deployment blocks and historical proxy/ABI intervals are not established. Etherscan creation metadata was plan-gated; the frontend's `deployBlock:1` remains rejected as evidence. No full-chain scan or full-history promise follows from this sample.
- **Provider resilience/finality:** only one provider per demonstrated chain was tested. Production polling cadence, recovery, independent reconciliation, backup and chain-finality policy still need implementation and testing.
- **Yield/TVL:** no authoritative APY history, Primus-attributable TVL or private realized yield was validated. A public strategy balance does not establish those metrics.
- **Private wallet views:** official owner authorization/decryption compatibility remains a separate security/integration gate. No viewing key, permit or plaintext position was handled.
- **SDK tools:** official modes and a Page SDK are documented, but no end-to-end SDK proof generation or local verifier was executed in these trials.
- **Application:** the first local web/API slice now reads a validated, sanitized artifact built from this evidence. See the [project README](../../README.md). A live hosted database, persistent worker and Vercel deployment remain outstanding; deployed UI/UX, API, workflow and E2E acceptance tests are still required.

These limitations gate the affected features; they do not require another environment publish merely to continue local development.
