# Evidence audit, feasibility and SDK decisions

Review date: 8 November 2026. This document distinguishes the supplied PRD's assertions, inspected official source, proposed product choices and still-unverified runtime behavior.

This is the initial research snapshot. For the subsequently implemented Page
Core 0.2.1 inspector and diagnostics pilot, see [SDK_TOOLS.md](../SDK_TOOLS.md).
Its genuine signed positive-fixture gate remains explicitly unverified.

Current data-source decision: the user requires free APIs and selected path 1, Base with bounded free RPC reads. [Decision 10](10-free-data-sources.md) records the evolution and exclusion of paid Base explorers. Base is selected for executable discovery, not certified for launch; there is no requirement to purchase RPC.

## Input and method

The complete uploaded `PrimusScope_PRD_Architecture_v1.docx` was extracted and reviewed, including tables, source links and its embedded architecture diagram. Original SHA-256: `26b31c174805c1112ed044adf75e5b5e0e02249bb24bb0eb61cf73062dacf234`.

The document is strong on privacy, source provenance and honest empty states. Its “confirmed” labels are the document author's claims; they are not automatically independently confirmed by this review. Its numbered engineering actions were treated as proposed backlog, not instructions to implement or deploy.

Actual checks: public official GitHub repositories and package metadata were read, exact source revisions recorded, and the official-hosted finance audit inspected. No SDK was installed/executed, no production RPC was queried, no wallet connected and no on-chain transaction sent. The application repository was empty before the planning documents were created.

Direct HTTPS requests to `docs.primuslabs.xyz` and `dapp.primuslabs.xyz` returned proxy tunnel `403 Forbidden`. This is an environment access limitation, not evidence of a Primus outage. No alternative-domain bypass was attempted. Live UI inspection and current docs comparison therefore remain open. Future research needs those domains permitted in environment settings, then a fresh connection and direct comparison; adding a domain to an unconfirmed draft would not establish access.

## Primary evidence and important corrections

The [network audit](research/network-source-audit.md) and [finance audit](research/finance-source-audit.md) contain immutable source URLs and detailed observations.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Official `network-core-sdk` at `ec157e816d108a6fabdd42cb3a83375618c217e0` | Task/node ABI source, multi-attestor requests, report fields, native states and supported reads | Current deployed bytecode, historical ABI compatibility, activity, finality or exact outcome-transition times |
| Official `primus-network-startup` at `74f25824365f4ccdb9e6b9fe5cda9b682fb321ab` | Chain/address discovery seeds | Runtime approval for every listed chain; agreement with every SDK constant |
| Official `zktls-contracts` at `e14c7b1ce35c6603ffa9393978e224998a41859b` | Verifier interface and inspected signature/trusted-attestor logic | A verification event, global proof count, explicit age/context policy or browser-local execution |
| Official `zktls-att-verification` at `c5f99a42f6ab3a8913dabdcac360a2be6429e945` | Additional verification code and a different processing path | Browser-compatible WASM or permission to send private data/AES material to a server |
| Official-hosted `fhetransform-resources` at `4be8575650923ddb30b39629107892d8cb65b54c` | Audit-documented BSC converter/aggregator addresses, batch clues and historical privacy observations | Current contracts/implementations, current vault inventory, live API, APY history or confidentiality certification |
| `fund-js-sdk` at `2282a3bb99c16581bb6776304f2d338342519b8d` | Social-account funding/claims workflow using zkTLS | Confidential-vault balances, batch APY or owner FHE decryption |
| `primus-fhe` / Unitas PoR client source | Low-level crypto / authenticated proof-of-reserves connectors | App-ready owner-private read SDK or public yield/TVL feed |

### Changes to PRD v1

1. **Task counting:** `ReportResult` is per attestor and has no success field. Separate request/report/outcome metrics; do not derive completions from report count.
2. **Task identity:** add `taskContract` to routes/API identity. Source-distributed states include partial-success variants. Do not invent a generic event-only lifecycle.
3. **Coverage:** SDK source adds BNB task seeds while its chain set differs from the startup repository's Ink listing. BNB task contracts are not finance contracts. No automatic multi-chain launch.
4. **Verification:** inspected verifier logic does not implement every semantic guarantee described in comments. Show executed signature/trust/context/freshness checks separately. A view call is not a public proof event; calling RPC with a payload is not wholly local processing.
5. **Finance discovery:** “all addresses TBD” is too pessimistic now; audit seeds exist. “Production verified” would be too optimistic. Preserve an explicit candidate → live-verified → approved progression.
6. **Privacy wording:** audit finding N14 discusses public settlement-metadata inference. Do not claim encryption makes all entry/exit, addresses or totals invisible. Do not enrich or reconstruct them. The audit is historical evidence, not a new claim of a present exploitable defect.
7. **Wallet authorization:** public network history needs no signature. SIWE and official private-read consent are separate. Memory-only private values cannot provide persistent across-visit history.
8. **Evidence model:** split origin, finality, verification, access, freshness and coverage instead of one overloaded class.
9. **Launch:** resolve the PRD's contradictory Finance gates by naming Network beta and full two-domain beta separately.

## Metric feasibility worksheet

`Candidate` means source evidence exists, not implementation readiness. All live integrations below remain unverified in this planning task.

| Feature | Source | Reproducible now? | Privacy/publication assessment | Launch state / next gate |
| --- | --- | --- | --- | --- |
| Requests and report timeline | Official task ABI + registered-chain logs | Algorithm defined; no live fixture | Public projection must exclude arbitrary payload strings | Candidate; verify Base deployment and real lifecycle |
| Current native task state | `queryTask` and status enum | Source API identified; no live read | Store minimal state, not full taskResults | Candidate; block-pinned reads and semantics |
| Historical task outcomes/latency | Events plus state history/archive | Not established | Same projection rule; uncertain times remain intervals | Gated until historical reconstruction proved |
| Task fee components | Report/withdraw fields | Not yet; token/retry/settlement rules missing | Public fee fields only, separate currencies | Gated pending accounting fixture |
| Registry/attestor facts | Official node ABI/read source | Algorithm candidate | No endpoint scraping or invented uptime | Candidate after live validation |
| Public wallet task history | Public submitter role | Candidate with coverage | No FHE/identity joins or ownership claim | R1 after validated task pipeline |
| Finance batch state/history | Audit candidates and actual event clues | No complete live ABI/lifecycle | Disclosure review across tables, charts, exports | Gated; validate current BSC implementations |
| Published yield history | Official strategy feed required | No authoritative source confirmed | Avoid implying realized private yield | Gated; identify source and history |
| Primus-attributable TVL | Reconciled backing/ownership model | Not established | High inference/misattribution risk | Off by default |
| Owner-private positions | Official client integration required | No supported route validated | No PrimusScope server transit/storage | Later, blocked on supported integration |
| Local attestation checking | Official schema/verifier candidates | Source inspected, browser feasibility untested | Payload remains local; SDK logging/network audit required | Later capability spike |
| Developer diagnostics | Opt-in adapter over supported SDK boundary | Design only | Strict event allowlist, no callback serialization | Pilot after one SDK/version validated |
| Points/reputation | Authorized official API required | No validated feed | No inferred rewards/identity enrichment | Deferred |

## Official SDK integration matrix

Observed package versions are research snapshots, not selected production pins. Review supported versions with Primus and lock dependencies only after compatibility tests.

| Package/source | Observed version | Useful PrimusScope role | Decision |
| --- | --- | --- | --- |
| `@primuslabs/network-js-sdk` | 0.1.11 | Browser Network reference integration and optional diagnostics | Pilot only; do not submit paid tasks from analytics; clarify inaccessible linked source repository |
| `@primuslabs/network-core-sdk` | 0.1.19 | ABI/types and supported task-read compatibility; backend example | Primary integration candidate behind a read-only adapter; do not import native proof engines into Vercel solely for indexing |
| `@primuslabs/zktls-js-sdk` | 0.3.15 | Browser/enterprise integration and possible verification-only flow | Validate selected schema, extension requirements, outbound reporting and supported verification entry point |
| `@primuslabs/zktls-core-sdk` | 0.3.9 | Backend enterprise example / later developer adapter | Not required for anonymous analytics; native environment and secret handling need a separate spike |
| `@primuslabs/zktls-contracts` | Release not verified | Schema-specific verifier source/interface | Distinguish RPC-based check from truly local verification |
| Lightweight Web SDK | Not established | Potential extension-free integration | Ask for current official entry point; do not equate with extension SDK |
| FHE owner-read SDK | Not established | Future authorized private positions | Do not substitute Fund SDK or educational crypto examples |

Pin provenance, integrity, supported mode/runtime, schema version, trust anchors and tested APIs. Inspect installed SDK logging/telemetry and transitive native dependencies. The network-core source contains reporting/logging paths, so “we do not log proofs” requires verifying SDK behavior as well as our wrapper. Never serialize entire callback/error objects into analytics.

Official SDK use should solve a concrete problem: richer supported task reads, transparent schema-specific checks, or useful opt-in integration diagnostics. Installing every package, moving app secrets into the browser or generating transactions solely for engagement would weaken the product. Source distribution and package licensing differ; public availability does not establish commercial/redistribution rights for every SDK binary. Clarify terms where metadata was absent.

## Completing the live comparison

When domain access is available, inspect anonymous official dApp and current docs without authorizing value-moving actions. Capture date, exact screen/URL and public evidence for: supported products/assets, visible historical charts, task-search ability, batch explanations, published APIs, source labels, wallet-required features and developer diagnostics. Do not assume a feature absent from the landing page is absent behind login.

For one production network: verify chain ID, code/proxy identity, ABI hash/version/deployment block and real finalized request with all available reports/native state. For one Finance candidate: confirm official identity, implementations, complete ABI and safe public data; identify at least one useful series or lifecycle. Reconcile a bounded sample before approving any metric.

Record source terms and attribution. Resolve SDK modes with official documentation and a supported compatibility example. Ask the team for missing interfaces rather than collecting credentials or reverse-engineering authenticated private endpoints. The collaboration brief lists the questions; no outreach has been sent.

This source-code audit is complete within the available access. Live-dApp comparison, RPC reconciliation, SDK execution, source permissions and private integration remain **unverified discovery gates**, not hidden completion claims.
