# PrimusScope UX and workflow specification

Planning baseline, 8 November 2026. This is a proposed design, not an implementation or a statement that every dataset is available. Live-source feasibility controls which modules launch. No claim that a feature is missing from the current Primus dApp should be published without a reproducible comparison.

## Product experience

PrimusScope should help a visitor **understand what changed, inspect the evidence, and keep track of what matters**. Network Analytics, Task & Proof Explorer, and Wallet Intelligence are three linked jobs. Confidential Finance and zkTLS Network remain first-class long-term domains, with different data and privacy boundaries.

The product should feel like an expert research workspace: readable charts, useful comparisons, clear explanations, fast search and saved views. Its distinction from Dune is domain interpretation and trustworthy workflows. A general SQL editor, token portfolio, universal wallet score or hundreds of charts is outside the first release.

The first public experience must answer useful questions without connecting a wallet. Finance launches only with a meaningful supported dataset, rather than a collection of unavailable widgets. A Network-only beta can be worthwhile, but must be described as a limited release rather than completion of the full product.

## Navigation and routes

Desktop uses a compact left navigation, persistent global search, visible environment selector and a source-status utility. Mobile uses a header with search and menu, followed by single-column content. Global filters include the selected time window and supported production chains; testnets require an explicit choice.

| Destination | Routes | Purpose and launch rule |
| --- | --- | --- |
| Overview | `/overview` | What changed across supported domains and followed public objects |
| Network | `/network`, `/network/chains/:chainId` | Registered-contract trends, outcomes, fees and coverage |
| Task & Proof Explorer | `/explore`, `/network/tasks/:chainId/:taskContract/:taskId` | Type-aware search and exact task evidence |
| Attestation verifier | `/explore/verify` | Local cryptographic/context checks; appears only when implemented and validated |
| Vaults | `/finance/vaults`, `/finance/vaults/:vaultId` | Supported public vault history, batches and sources |
| Workspace | `/workspace` | Local watchlists, saved filters and public network-task lookup |
| Private positions | `/workspace/private` | Later owner-authorized view through a supported official integration |
| Developer Studio | `/developers/apps/:appId` | Later opt-in, app-owned diagnostics |
| Sources & status | `/sources`, `/methodology/:metricKey`, `/status` | Coverage, calculations, contract versions and incidents |

An exact task identity includes chain, task contract and task ID. A chain/task pair is insufficient when contract versions reuse identifiers. A shorter shared link may resolve to this complete identity, but must not silently select a contract.

Utility routes remain accessible from every chart. Features that have no useful supported data stay out of primary navigation. Explain planned capabilities in product documentation rather than showing a large disabled menu.

## Daily use and screen priorities

### Overview

The first screen answers “What changed since my last visit?” rather than displaying an unqualified total-proofs number. Show separate Network and Finance summaries when supported, a recent comparison, followed public objects and source incidents. Give each domain its own coverage and freshness label.

A concise change statement links to its chart and underlying evidence. Do not automatically claim growth when the comparison spans different indexed ranges. A new contract entering coverage should produce a coverage annotation, not an unexplained adoption spike.

First-visit users see a useful default view. Returning visitors can choose public chains, vaults and metric views to follow locally. Local saved preferences provide value without accounts, signatures or notification infrastructure. “Follow” initially means save to this browser; it must not imply email or push alerts.

### Network

Prioritize a small set of reproducible measures: recognized requests, task status distribution, distinct public interacting addresses, observable protocol fees and chain distribution. Label addresses as addresses, not people. Gas, protocol fees and different native-token units remain separate.

A chart selection opens the matching task table. Period comparison uses consistent scope. Task creation cohorts and outcomes observed during a calendar period are different views and must have different labels. Never count pending tasks as explicit failures or present per-attestor reports as successful proofs.

Parallel source research found an official SDK ABI with a multi-attestor `SubmitTask` and per-attestor `ReportResult` without a success field. The UI therefore needs both per-attestor observations and separately resolved overall task state. Supported `queryTask` reads and version-specific semantics must establish any stronger status; the first report is not automatically completion.

### Explorer and task detail

Search accepts a transaction hash, address, chain-qualified task reference, or exact task link. Classify the input, request disambiguation when necessary, and explain coverage before presenting results. Addresses can lead to known contracts or public network-task views; they must not become confidential-finance surveillance pages.

Task detail has identity, current observed state, coverage/finality, a chronological event timeline, assigned/reporting attestors where exposed, supported fees and original source links. Preserve ABI-specific meaning rather than inventing intermediate stages or estimated deadlines.

Attestation verification occupies a distinct panel. “Task settled” must never imply “Proof verified.” If no attestation was supplied or located through a supported source, say “No attestation available to check.” Verification results distinguish signature validity, trust anchor, schema/version, context/policy and expiry where supported. Unsupported is different from invalid.

### Vaults and vault detail

When source discovery passes, the directory shows verified identity, underlying strategy, published yield with observation time, supported public batch state and source availability. It does not rank safety from APY.

Detail prioritizes the historical series that actually exists: published strategy APY, a reproducible share-price return, or a public batch timeline. Label strategy yield separately from user yield and incentives. Public strategy capital is not automatically Primus TVL. A historical chart starts at the first supported observation; it must not manufacture a past series from today's rate.

Batch progress includes only observed, validated stages. Official-hosted audit material can seed discovery, but is not sufficient proof of current live contracts or state transitions. Omit participant amounts and individualized confidential activity. Transaction handoffs explicitly say “Open official Primus dApp.”

### Workspace and Wallet Intelligence

First-release Wallet Intelligence means useful public network-task history, public-object watchlists and saved views. Public address lookup is anonymous; a signature is unnecessary for public data. Distinguish “watching an address” from a verified ownership claim.

Private positions are a separate later capability. Flow: read the purpose → connect → authenticate only where needed → separately authorize the supported official private read → display locally. SIWE ownership alone does not grant FHE decryption permission.

The private view may show current authorized balances, positions and request states, with actions handed to Primus. Decrypted values, permits and sensitive proof data do not enter PrimusScope analytics, logs, URLs or backend storage. Clear private state on disconnect, expiry and account switch.

Memory-only state cannot provide persistent history across visits. Show official authorized history if supported. Device-local encrypted snapshots require a separate opt-in design; do not promise historical tracking from transient browser memory.

## Core workflows and failure paths

| Workflow | Successful path | Failure and recovery |
| --- | --- | --- |
| Understand a change | Overview → Network → compare period → open methodology → inspect source task | Partial coverage disables misleading comparison; stale sources show last observation and incident link |
| Find a task | Paste hash/reference → choose chain/contract if ambiguous → task detail → original explorer | Malformed input is rejected early; uncovered scope is distinguished from covered-not-found; preserve input for correction |
| Monitor public interests | Workspace → followed chain/vault → change detail → saved filtered view | Missing browser preferences returns a clear first-use state; disabled source stays listed with reason rather than disappearing |
| Inspect a vault | Directory → published performance → supported batch timeline → official dApp | Missing yield history offers available facts and source explanation; unavailable Finance is not replaced by demonstration figures |
| Verify an attestation, later | Select local file/paste → supported checks → separate results → clear | Malformed, oversized, unsigned, wrong-context, expired and unsupported inputs have distinct outcomes; never upload silently |
| Read own private position, later | Explain access → official authorization → local display → official action handoff | Rejected signature returns safely; expired permit clears state; unsupported integration blocks private values without blocking public pages |
| Diagnose an integration, later | Register app → privacy preview → sanitized test event → version/error comparison | No events prompts setup diagnostics; low samples suppress strong reliability claims; tenant/ingest failures give actionable codes |

Browser back navigation preserves public filters. Share URLs carry public filters and stable object identity, never private values, raw attestations or authorization material. Export uses the exact visible scope and includes units, time basis, as-of/version, sources and exclusions.

## Availability, evidence and status language

Every primary chart shows name, unit, selected period, source freshness and a short coverage label. One action opens formula, contract/source references, finalized height, transformation version and caveats. Avoid six competing badges on every number.

Origin, finality, verification and access are separate attributes. For example, developer-supplied data may be cryptographically checked while remaining session-only; one flat “evidence class” is insufficient to explain all three facts.

| State | User-facing behavior |
| --- | --- |
| Loading | Skeleton with stable layout; no temporary zero |
| Complete, zero activity | Show zero only for a fully scanned, supported scope; explain its boundaries |
| Partial range | Show available range, missing interval and impact on comparison/export |
| Not indexed | Explain that the selected period/contract has not been covered |
| Stale | Preserve last supported observation with timestamp and delayed badge |
| Source unavailable | Explain source failure without claiming protocol failure or lost funds |
| Confidential | Explain that the value is protected; no suggestion of bypass or reconstruction |
| Unsupported | Explain missing capability and show available alternatives |
| Invalid search/input | Specific correction guidance before RPC or verification work |
| Not found in covered scope | Name searched chain/contracts and indexed range; offer correction |
| Provisional/reorg affected | Mark data separately from finalized analytics; explain revision |

Health labels distinguish protocol state from PrimusScope infrastructure. “Our indexer is delayed” is not “Primus is down.” A contract pause requires a verified source observation. No source heartbeat alone supports a financial-risk claim.

## Responsive, accessible and trustworthy interaction

Use readable sans typography with tabular numerals; monospace is reserved for technical identifiers. A restrained terminal aesthetic is appropriate, but small text contrast and useful density matter more than neon styling. Dark and light palettes must be tested on actual controls, chart legends and disabled states.

Design at 360, 390, 768, 1024 and 1440 pixels. Mobile has single-column cards, 44-pixel touch targets, compact summaries and drill-down. Dense desktop tables become labeled cards or prioritized columns; do not force a twenty-column horizontal sheet. Charts have table alternatives and textual summaries.

Keyboard users can operate search, filters, tabs, dialogs, range selection, provenance and export. Visible focus, logical headings, meaningful link labels, announced search/error states, reduced motion and color-independent status are required. Verify critical flows with keyboard and screen reader, rather than treating an automated accessibility score as complete evidence.

Store timestamps and bucket boundaries in UTC; explicitly label the display timezone. A shared view should not silently change totals when opened in another timezone. User-facing times can use a selected local setting, with stable source timestamps available in details.

Avoid session replay and sensitive search recording. Do not preload wallet packages into anonymous critical paths. Connect prompts appear only after a user requests a capability that needs them; no auto-opening on page entry or scrolling.

## Curated analytics before a Dune-style query platform

Start with tested metric definitions, saved filters, shareable public views and correct CSV exports. Later allow users to compose dashboards from approved metric blocks. This gives flexibility while preserving source and privacy rules.

Arbitrary SQL, raw RPC proxying, private dataset joins and freely filterable confidential aggregates create separate security, cost and inference problems. They need a dedicated product and execution model. They are not prerequisites for a useful Primus analytics companion.

## UX acceptance before release

A usable beta lets an anonymous visitor learn one correct, useful fact, trace its source and find an exact supported task. Every launched module has meaningful data or a purposeful source explanation; demonstration data is explicitly isolated. Saved public views create a return path. Mobile, keyboard, stale-source, partial-coverage and ambiguous-search flows are tested alongside success flows.

Developer telemetry and owner-private positions have independent launch gates. Their availability is never implied by polished navigation or a wallet connection. The finished UI should make both its capabilities and its limits easy to understand.
