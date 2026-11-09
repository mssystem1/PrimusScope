# Product, scope and build sequence

Current sequencing correction: [BSC Finance first via Etherscan V2](11-bsc-finance-first.md) supersedes the Network-beta-first release order below. Prioritize a validated U/eU or USDT/eUSDT public analytics slice on chain 56. The separate zkTLS Network/Proof features remain in the product vision but do not make Base a prerequisite.

## Product thesis

**Know what happened across Primus, understand the evidence behind it, and keep track of what matters to you.**

The product has three user jobs: Network Analytics, Task & Proof Exploration, and Wallet/Workspace Intelligence. Finance Intelligence applies those jobs to publicly measurable confidential-finance operations. Long term, Finance and Network deserve clear, first-class navigation; actual release visibility follows source readiness.

The Dune analogy is useful for interactive charts, transparent methodology, saved analyses and shareable filters. The distinctive value is Primus-specific interpretation: multi-attestor task lifecycles, partial outcomes, proof verification boundaries, privacy-aware finance observations, SDK diagnostics and source health. A SQL editor alone would not supply that value.

## Users, useful answers and recurrence

| User | Question | First useful experience | Repeat-use mechanism |
| --- | --- | --- | --- |
| Active network user | What happened to my task? | Exact request, reports, native observed state and sources | Follow tasks locally; highlight newly observed state |
| Ecosystem analyst | What changed, and is the trend real? | Consistent request/outcome/fee charts with explicit coverage | Saved filters, comparable-period changes and source-health updates |
| Vault depositor | What changed for the strategy or batch I follow? | Published yield history and actual public batch state, when validated | Follow a vault; show new published observations and staleness |
| Integrator | Did a version change break my integration? | Own opt-in SDK outcomes, errors and duration by version | Developer health view and later sample-aware alerts |
| Private owner | What is my own position or request state? | Supported official owner-authorized local read, later | Current authorized status; history only if a real supported source exists |

Task lookup is often episodic; do not claim charts alone create daily usage. The strongest daily-use hypothesis is developer diagnostics, followed by active-task monitoring and meaningful vault updates. Validate those hypotheses before implementing accounts, notification systems or a broad dashboard builder.

## Everyday loops in the first release

- **Check → understand → follow:** a visitor inspects a source-backed metric or task and saves its public object locally.
- **Return → notice a change → verify:** show changes since the last successfully observed watermark, with a source link and correction marker if history was recomputed.
- **Filter → save → share:** prebuilt analyses accept chain, contract, time and supported-status filters. Public share URLs reproduce the same bucket timezone and scope; no private payloads enter URLs.
- **Question → evidence:** any numeric card opens its definition, formula, coverage and source events. Interpretation is the product, not a tooltip afterthought.

A watchlist is a user-selected convenience, not monitoring of confidential-wallet activity. Initial persistence is device-local preferences containing public object IDs and last-seen watermarks. It offers no cross-device synchronization or background push alerts. Decrypted values, proof content, permits and secrets never enter it.

## What to ship

### R0 — Evidence and design baseline

Outputs: this planning package, approved registry candidates, metric feasibility worksheet, native lifecycle dictionary, dApp comparison evidence and representative acceptance fixtures. Discovery can involve read-only source/RPC checks. It must not submit paid tasks or touch funds to manufacture activity.

Exit: a useful Network vertical slice is feasible, each intended metric has a source and definition, and Finance inclusion has a separate explicit decision. The full product concept is not yet considered implemented.

### R1 — Network beta

Required: one supported production network and contract version; Overview; Network charts; exact task/transaction exploration; public address-to-task lookup; local public-object workspace; source/methodology/status; source-backed CSV export; responsive and accessible UI; deployed preview and production smoke evidence.

Start with 4–6 justified metrics: requests, per-attestor reports, native observed outcome distribution where safely obtainable, publicly observed interacting addresses, and fees separated by token/component. If outcome history is not established, show current outcome snapshots with an explicit as-of and avoid historical completion charts.

Excluded from the beta claim: all-Primus usage, all proofs, finance holdings, real-time node uptime, private history, leaderboard points, arbitrary SQL and universal wallet scoring. Do not render unsupported destinations as a wall of fake data or permanent placeholder charts.

Exit: known real task round-trip through ingestion → API → deployed UI; deterministic replay/outage/identity tests; clear coverage; meaningful repeat-use loop; required UI/API/E2E checks pass. See document 06 for evidence requirements.

### R2 — Finance + Network beta

Add at least one live source-verified vault/strategy with either useful public historical yield observations or meaningful privacy-reviewed public batch history. A directory alone, or all values unavailable, does not satisfy the Finance value promise.

Include published strategy yield, source changes, batch state/timing and public contract status only when validated. Keep incentives separate. A public strategy's total assets are not automatically assets attributable to Primus depositors. No confidential TVL proxy or per-wallet confidential history.

Exit: verified finance identity and semantics, reproducible calculations, historical coverage, disclosure review including exports/filter combinations, and the Finance deployed workflows pass. Network and Finance retain separate metric definitions and coverage.

### R3 — Developer and verification tools

Two independent tracks can proceed when technically demonstrated:

- Official SDK-based, schema-specific attestation inspection with local processing, bounded resource use and separate crypto/trust/context checks.
- Developer Studio for one SDK mode and a small pilot: strict opt-in event schema, per-application isolation, retention/deletion, sample-aware duration/outcome metrics and no sensitive payload capture.

Developers' reported SDK activity is a participating sample, not a global network census. Client telemetry keys cannot be treated as secret or make untrusted reports cryptographically authoritative.

### R4 — Private owner insights and ecosystem expansion

Private FHE reads require an official supported integration and a separate security gate. SIWE proves control of an address; it does not decrypt balances. Current local positions are a valid scope. Persistent history needs official historical access or a separately designed encrypted local snapshot feature; RAM cannot provide across-visit history.

After user value is established: more chains/vaults, account-synced preferences, delivery alerts, public API plans, embeds and dashboard composition. Points/rewards require an authorized source; no reward predictions.

## Differentiation to validate

| Hypothesized gap | Proposed PrimusScope value | Evidence still needed |
| --- | --- | --- |
| Limited retrospective analysis | Reproducible time series and comparable windows | Current dApp screens, historical source availability |
| Hard-to-explain task state | Request/report/outcome timeline and source provenance | Live native-state semantics, existing explorer capabilities |
| Hard to monitor integration regressions | Opt-in SDK version/error/duration comparison | Integrator feedback and official SDK hooks |
| Hard to follow relevant changes | Saved public objects and since-last-visit digest | Frequency and usefulness of real updates |
| Unclear trust of dashboard numbers | Methodology and coverage one action away | Review of existing official metrics and source terms |

These are hypotheses. No claim that today's Primus dApp lacks them is justified by this review.

## Success measures

North star: returning users who resolve a meaningful, source-backed question. Supporting measures: successful lookup within covered scope, repeat watched-object usage, source/definition inspection, diagnosed developer regressions, source accuracy, freshness and data incidents. Measure using coarse events without raw addresses, task search strings, proof subjects or private values. Do not add session replay to private surfaces.

Before expanding scope, conduct a proposed small usability round with active network users, integrators and finance users: observe whether they can identify current state, explain the metric and name a reason to return. Outreach requires separate authorization; this plan sends no messages.

## Build defaults and decision ownership

Product owns scope and honest naming; data engineering owns registry and formulas; security owns private-read/publication boundaries; full-stack owns usable workflows and accessibility. Roles can be held by one builder, but evidence cannot be skipped.

Default decisions: one network first; device-local saved public views; no wallet prompt on public pages; source-gated Finance; official SDK adapters; modular monolith; Vercel web/API with external worker. Remaining evidence dependencies are listed in document 05 rather than turning every ordinary choice into a user question. No calendar or delivery guarantee is inferred from phase order.
