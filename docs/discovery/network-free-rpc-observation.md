# Separate zkTLS Network: free RPC observation

Observed **9 November 2026, 07:43 UTC** in the current `96d797f68b…` environment. This is parallel ecosystem-source validation. BSC Confidential Finance remains a separate product/data module.

## Actual result

The keyless endpoint `https://base-rpc.publicnode.com` returned chain ID **8453** and accepted bounded read-only code, storage, block, log, receipt and task-state requests. No API key, wallet, signing operation, configuration change or publication was used.

The trial made **10 requests** with a maximum budget of 20, ten-second request deadlines, one-second pacing and a 120-second run deadline. It completed in approximately **9.1 seconds**. The 10,000-block trial produced events immediately, so no 50,000-block expansion was attempted.

| Scope / observation | Result |
| --- | --- |
| Registered task contract | `0x151cb5eD5D10A42B607bB172B27BDF6F884b9707` |
| Block interval, inclusive | `55081642`–`55091641` |
| Provider-reported finalized target | `55091641`, hash recorded in JSON |
| `SubmitTask` events | 116 |
| `ReportResult` events | 90 |
| `WithdrawBalance` events | 17 |
| `CallbackFailed` events | 0 in this bounded returned scope |
| Total recognized events | 223 |
| Selected request/report task | Both request and report observed; receipt/task ID reconciled |
| Pinned native state for selected task | `SUCCESS` (code 1) at target block |
| Cryptographic attestation verification | **Not run** |

The [sanitized JSON observation](network-free-rpc-observation.json) contains public event identity, task ID where supported, source/version hashes, a safe request ledger and the selected lifecycle evidence. Indexed sender/attestor addresses, templates, raw dynamic event data, full `queryTask` results, source response subjects and private proof material are absent.

## What was checked

The task ABI subset is pinned to official `primus-labs/network-core-sdk` commit `ec157e816d108a6fabdd42cb3a83375618c217e0`, with SHA-256 `ae16dd8f4d7f3dd5ffed3b1c8208f6e1cf4ae44157edc6b3185b3f1440019ed8`. Event topics/function selectors came from that source fixture.

Observed task proxy code was 793 bytes. Its EIP-1967 implementation slot pointed to `0xfda482dd37609f11fd0e8c415cccfd4f070a1845`, with 21,313 bytes of implementation code. Recorded SHA-256 fingerprints match the earlier Base observation. This is an observed proxy-slot/code fingerprint, not an independently matched deployed source or full implementation-history approval.

The sample task's `SubmitTask` and `ReportResult` appear within the same bounded scope. A receipt matches its transaction, block, log index, contract/topic and safe first-word task ID. The block-pinned `queryTask` result successfully projected only native status and submission timestamp using the pinned ABI's tuple index 7 for `taskStatus`. Full attestation output was not retained. The target block hash was rechecked after the work and remained the same.

## Metric and coverage boundaries

- **90 reports are not 90 completed tasks or verified proofs.** Reports are per attestor. No completion rate is computed from reports divided by requests.
- The selected task's native `SUCCESS` is a contract-state observation, not independent cryptographic validation of a supplied attestation.
- These counts apply only to the registered contract and the named block interval. They are not global Primus usage, all SDK modes, historical totals or unique humans.
- A provider's `finalized` tag was observed; independent consensus/finality-policy review and full-history completeness are not established by this sample.
- Returned logs were structurally validated and deduplicated by canonical event identity. Independent omission detection and full backfill reconciliation remain work.
- The endpoint is keyless and no paid source was configured. Long-history availability, service limits, sustained throughput and production reliability were not established by ten calls.
- Base fees have execution and L1 components; the JSON sample preserves separate reported components and does not present execution gas as total transaction cost or protocol revenue.

## Product implication and next gate

A separate Network explorer vertical slice is technically plausible without treating Base as the Finance chain: exact task search, request/report timeline and native state can be source-backed. It should share provenance/status UI with Finance while keeping chain, contract, task ID, mode and methodology explicit.

Before promoting this source to production coverage, establish deployment/history boundaries, source/implementation ABI validity, gap/reorg recovery, quota/failover behavior and the correct cohort definitions. No server-side proof upload, private-wallet correlation or universal proof total is justified.
