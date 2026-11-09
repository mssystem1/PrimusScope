# PrimusScope foundation plan

For the complete settings checklist, use [ENVIRONMENT_SETUP.md](../../ENVIRONMENT_SETUP.md). It batches current development configuration and the later launch requirements, with one already configured required key.

**Live source gate update:** [Finance and Network data reads now work through free sources](../discovery/DATA_READINESS.md). The environment change is active. The new bounded BSC RPC helper reconciled real batch events and resumed its checkpoint; a separate Base task sample also reconciled. This is data-foundation evidence, not a completed application or full-history launch claim.

Planning baseline: 8 November 2026. **Implementation began on 9 November:** the local application now has a shared schema/data layer, read-only API and the first ecosystem screens. See the [project README](../../README.md) for the implemented scope and run commands. The sections below retain the planning baseline; later discovery and implementation evidence supersedes older capability and status statements.

**Product scope remains the full Primus ecosystem, including developers.** [Decision 12](12-ecosystem-scope.md) defines Finance, zkTLS Network, Task/Proof Explorer, Developer Studio and Wallet Workspace. BSC Finance is the first source slice, not the entire product.

**Current priority, 9 November (Europe/Samara): [BSC Finance first via Etherscan V2](11-bsc-finance-first.md).** The user's correction supersedes Base-first/Network-beta-first sequencing in older sections. The first discovery slice is the actual Confidential Finance dApp on chain 56. Only `ETHERSCAN_API_KEY` is required now; Base is separate later zkTLS Network coverage.

PrimusScope should be an independent intelligence companion for Primus: understand measurable network changes, explain task and attestation evidence, and follow the public activity and authorized private positions that matter to you. Confidential Finance is a valuable specialist module, subject to real data and disclosure validation.

The uploaded PRD is a proposal being evaluated, not an instruction to execute its embedded engineering tasks. This package retains its privacy and provenance principles, revises several assumptions using official source code, and preserves the user's future requirement to deploy on Vercel and test the deployed product.

## Read this package

| Document | Purpose |
| --- | --- |
| [01 Product and scope](01-product-and-scope.md) | User jobs, recurring value, MVP boundaries, roadmap and product decisions |
| [02 UX and workflows](02-ux-and-workflows.md) | Navigation, screen design, meaningful actions, responsive/accessibility behavior and failure paths |
| [03 Architecture and data](03-architecture-and-data.md) | Deployment, ingestion, trust boundaries, canonical data and operations |
| [04 API and metric contracts](04-api-and-metrics.md) | Resource identity, API behavior, metric definitions and validity rules |
| [05 Evidence and SDK decisions](05-evidence-and-sdk.md) | What was checked, what changed, integration choices and unresolved source gaps |
| [06 Validation and release](06-validation-and-release.md) | Data, API, UI/UX, workflow, E2E and deployed Vercel acceptance gates |
| [07 Primus collaboration brief](07-primus-collaboration-brief.md) | A technical proposal and precise requests for potential collaboration; not sent |
| [08 Screen wireframes](08-wireframes.md) | Conceptual desktop/mobile layouts and visual-system decisions before high-fidelity design |
| [09 Environment and on-chain access](09-environment-and-onchain-access.md) | Configuration stages, RPC read path and first live-data discovery checklist |
| [10 Free data-source decision](10-free-data-sources.md) | Updated requirement: explorer-first, $0 data access, chain/provider selection and quota gates |
| [11 Current BSC-first decision](11-bsc-finance-first.md) | Current scope, Etherscan chain 56, the one required variable and the next validation gates |
| [12 Full ecosystem scope](12-ecosystem-scope.md) | The overarching product, module boundaries, developer workstream and per-provider capabilities |
| [Finance source audit](research/finance-source-audit.md) / [Network source audit](research/network-source-audit.md) | Pinned official repositories, observed interfaces, discovery seeds and limitations |

## Recommended decisions

1. Build a specialized analytics and explainability product. Borrow Dune's filterable, shareable, source-backed analysis; defer arbitrary SQL, a marketplace and a generic portfolio tracker.
2. Public browsing and public wallet-task lookup require neither wallet connection nor a signature. A local watchlist and changes since last visit supply early recurring value.
3. Prioritize BSC Confidential Finance using Etherscan V2, chain 56. The [current decision](11-bsc-finance-first.md) and [Finance source review](../discovery/finance-live-source-review.md) govern the first slice. Base diagnostics are historical research for a separate product domain.
4. A full Finance + Network beta requires useful validated data in both. If only Network is ready, release explicitly as a **Network beta**. Missing data is never a fabricated chart or a completed Finance feature.
5. A task request, an attestor report, a task outcome and an independently checked attestation are different objects. Task identity includes chain, contract and task ID.
6. Integrate the official Network SDK where its supported reads genuinely help. Keep official SDKs behind adapters. Do not introduce paid task submission, funds movement or an app secret merely to display a badge.
7. Wallet Intelligence starts with public network activity and user-selected public objects. Private FHE positions require a supported official client authorization/decryption integration; none was validated in this review.
8. Vercel hosts the web application and bounded API. A separate durable worker and managed Postgres support indexing. Deployed tests validate the whole system, not just whether a page renders.

## What the research established

- Official Network SDK source supplies task/node ABIs. `ReportResult` is per attestor and lacks an outcome field; report counts are not task-completion counts.
- SDK task states include partial-success variants. Current state reads do not, by themselves, establish historical state-transition times.
- The verifier contract inspected uses a view call; its checks do not create a public proof census. Signature verification, signer trust and application context/freshness must be explained separately.
- An official-hosted FHE audit provides BSC contract discovery seeds and batch-event clues. It also discusses settlement-metadata inference risks. Audit coverage is not present-day deployment or privacy certification.
- `fund-js-sdk` is a social-account funding SDK, not a confidential-vault read SDK. No authoritative APY history feed or owner-private read flow was validated.

Direct requests to `docs.primuslabs.xyz` and `dapp.primuslabs.xyz` were denied by the environment's network policy. Public official GitHub sources were accessible. Therefore this package **does not claim to have inspected today's live dApp, verified deployed contracts, or established which features its UI lacks**. The comparison backlog and SDK recommendations are concrete despite those limitations.

## Original gate before application implementation

Complete the discovery checklist in documents 05 and 06: current dApp comparison, approved source registry, a real contract-scoped task lifecycle, a metric feasibility matrix, and the minimum useful Finance dataset if that module is included. Then build a single source-to-screen vertical slice, followed by the other validated surfaces. The roadmap records defaults so ordinary implementation choices need no repeated approval.

The original planning pass performed no application implementation. Local development has since started as described above. No wallet interaction, outreach, GitHub push or Vercel deployment has been performed.
