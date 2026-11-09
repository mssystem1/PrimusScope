# PrimusScope: full ecosystem scope

Clarification date: 9 November 2026, Europe/Samara. **BSC Confidential Finance is the first source slice, not the limit of the product.** This clarifies decision 11 and preserves the original ecosystem/developer objective.

## Product modules

| Module | User question | Sources and boundaries |
| --- | --- | --- |
| Ecosystem overview | What changed across the Primus systems we cover? | Independently labelled domain summaries, coverage, source health and saved public views; no combined finance-operations/proofs total |
| Finance Intelligence | What happened in public vault/strategy operations and batch processing? | BSC U/eU and USDT/eUSDT source registry, validated events/getters and official yield observations when available; no confidential amount inference |
| zkTLS Network | What happened to network requests and attestor reports? | Registered Primus network task/node deployments, potentially multiple chains; native task state separate from report counts and proof validity |
| Task & Proof Explorer | What evidence supports this task or attestation result? | Contract-scoped task timelines and later schema-specific local verification with explicit trust/context checks; not a universal proof corpus |
| Developer Studio | Is my Primus integration working, and what changed after an SDK/template update? | Official SDK compatibility tooling, later opt-in app-owned success/error/duration observations; no cookies, raw responses or identity payloads |
| Wallet Workspace | Which public objects and owner-authorized insights matter to me? | Local public watchlists and covered network activity first; private FHE positions only through a supported official owner-read flow |
| Sources & Status | Can I trust this number and how complete is it? | Contract/ABI/metric versions, provider capabilities, freshness, incidents and correction history |

The official dApp remains the place for funds-moving actions. Its portfolio and transaction surfaces already exist. PrimusScope's value is ecosystem-wide history, interpretation, diagnostics and monitoring with reproducible sources.

## Shared foundation, separate data products

Use common UI patterns, time filters, source panels and API schemas. Keep Finance events, Network requests/reports/native states, verification receipts and developer telemetry in distinct domain models. A shared wallet identifier must not become a join that profiles confidential finance or links proof subjects without informed consent.

Adapters declare capabilities by provider, chain, contract, time range and API operation. One provider key does not imply every endpoint or chain is available. Scope finance batches by `(chainId, aggregator, batchId)`; network tasks by `(chainId, taskContract, taskId)`; developer events by `(appId, eventId)`.

Base research remains useful for later Network coverage, but does not replace the BSC dApp dataset. Additional chains launch only when useful source coverage is validated, rather than because the chain is EVM-compatible or listed in a repository.

## Implementation sequence

Work can proceed in parallel after source gates: shared shell/design system and provenance contracts; BSC finance source validation; Network source compatibility; and developer SDK/tooling prototypes with authentic supported flows. Do not wait for every Primus feature to be available before preparing common foundations, and do not launch empty/fabricated metric modules.

The first source-to-screen slice is BSC Finance. Developer Studio and Network are explicit workstreams, not discarded features. Their launch order follows validated data and useful user workflows. Each gets its own API/privacy/acceptance gate, followed by real Vercel-deployed browser/API/workflow/E2E evidence.

## Actual current capability evidence

The Etherscan key is securely configured and source/ABI metadata succeeded for all four configured Finance aggregators. Three separate data-operation probes returned the provider's free-plan unsupported response: logs, proxy block number and time-to-block. See [the endpoint capability record](../discovery/bsc-etherscan-capabilities.json).

Source metadata is usable. Subsequent [live validation](../discovery/DATA_READINESS.md) established a separate keyless public RPC path for bounded BSC Finance and Base Network events, receipts and selected native states. Etherscan's plan restriction still applies to its blocked operations. The current implementation combines supported metadata with recorded observations from those independently tested RPC sources.

No production dashboard, full-history dataset, private wallet read, SDK telemetry census or Vercel deployment is claimed complete by these discovery results.
