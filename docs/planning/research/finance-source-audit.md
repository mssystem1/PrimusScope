# Official Primus finance source review

Review date: 8 November 2026. Planning evidence only; no production code, wallet interaction, on-chain transaction, or deployment executed.

## Findings that change the plan

1. **There is an official-hosted discovery route for finance contracts beyond the PRD's entirely-TBD registry.** `primus-labs/fhetransform-resources` contains a SlowMist audit report with BSC contract addresses and code excerpts. They are audit-documented discovery seeds, not a present-day canonical registry. Live bytecode, proxy implementation, ABI completeness, deployment blocks and actual activity remain unverified.
2. **The publicly named Fund SDK is not the confidential-finance SDK.** Its README describes sending crypto to social accounts using zkTLS. It should not be adopted for encrypted vault balances, APY or batching.
3. **`primus-fhe` is a low-level Rust cryptography workspace, not evidence of an application-ready browser owner-decryption integration.** It offers arithmetic/lattice/RNS/NTT/etc. crates; do not use the repository name to infer an official FHE wallet integration.
4. **The finance audit itself documents a material privacy constraint.** N14 discusses public settlement metadata, participant linkage and low-participant/differential inference. Its existence strengthens the PRD's conservative publication boundary. Being public on-chain does not automatically make a derived financial aggregate suitable to publish. A PrimusScope UI privacy filter cannot repair protocol-level exposure, and a nominal address count is not an anonymity guarantee.
5. **No public historical yield endpoint, authorized private-position read integration, or stable production dApp API was established by these sources.** There is enough evidence to define a discovery backlog; there is not enough to promise live APY charts or owner balances.

## Sources and immutable pins

| ID | Official repository | Inspected commit | Files |
| --- | --- | --- | --- |
| F1 | https://github.com/primus-labs/fhetransform-resources | `4be8575650923ddb30b39629107892d8cb65b54c` | `README.md`; `audit-reports/FHETransform Dapp - SlowMist Audit Report.pdf`; corresponding Spacebridge audit PDF |
| F2 | https://github.com/primus-labs/fund-js-sdk | `2282a3bb99c16581bb6776304f2d338342519b8d` | `README.md`, `README/overview.md`, file inventory |
| F3 | https://github.com/primus-labs/primus-fhe | `32b316b6728c32477ff93934d74943c29c37e52b` | `Cargo.toml`, workspace file inventory |
| F4 | https://github.com/primus-labs/por-client-unitas | `a54467d4360f1dd68f2c07977fdad6f51ae94b9d` | `README.md` |

Pinned source links:

- F1 audit: https://github.com/primus-labs/fhetransform-resources/blob/4be8575650923ddb30b39629107892d8cb65b54c/audit-reports/FHETransform%20Dapp%20-%20SlowMist%20Audit%20Report.pdf
- F2 overview: https://github.com/primus-labs/fund-js-sdk/blob/2282a3bb99c16581bb6776304f2d338342519b8d/README/overview.md
- F3 workspace: https://github.com/primus-labs/primus-fhe/blob/32b316b6728c32477ff93934d74943c29c37e52b/Cargo.toml
- F4 README: https://github.com/primus-labs/por-client-unitas/blob/a54467d4360f1dd68f2c07977fdad6f51ae94b9d/README.md

F1 Dapp PDF SHA-256: `cc7dc87f16837db65d7a829ba53b8843824c6b9423a474ba73461835c0a0bf29`.

Local read-only research checkouts: `/tmp/primusscope-research/`. Extracted audit text: `/tmp/primusscope-research/fhe-dapp-audit.txt`.

## F1 audit: what it actually says

The introduction describes shielding ERC-20 assets into confidential tokens, transfers without public amounts, unshielding, and confidential aggregators combining deposits into batches. It names ERC-4626 vault deposit/redemption and Unitas mint/redeem flows between assets such as USDT and staked USDu. Finalized batches allow private claims according to an exchange rate, while cancellation permits recovery. This is an architectural description, not confirmation of the current live app's asset inventory or APY.

The report references the FHETransform code repository and these reviewed code revisions:

- Audit: `956ceaf9cad67638e628316975537520108be37a`.
- Fixed version: `4ee33fade355939a5cf5433d2a9acc22cf8ae0d1`.
- Additional Unitas scope: `20f112c0f426624f245dcb9148afe9d7ad50746b`.

Do not assume those code commits are the implementations currently deployed. The underlying FHETransform code repository itself was not independently retrieved during this review.

### Audit-documented BSC discovery seeds

| Role in audit | Proxy address | Implementation stated in audit |
| --- | --- | --- |
| ConfidentialConverter | `0x3EcB7d91C98ca4B4924e0CC5Eca7472b21F06800` | `0x15c0ac633EF2D7F94d1b56245CcAC82Abd1D72A7` |
| RestrictedConfidentialConverter | `0x06776741b1f8bfF5ea51750E91edcf03ed8C6994` | `0x18d3F55b450f092bBbcF729d866b8CF090827353` |
| UnitasMintAggregatorConfidential | `0xedcDd426f7690c7Da365f8E9BE0C396353e5dd24` | `0x8b6213044534be95c7D889594CEDaAee7757C29D` |
| UnitasRedeemAggregatorConfidential | `0xBef1366512ffFF33cdd6C48d66e48D33c6dbCa22` | `0xa2652e6c1a825A18567Fa670fF9B4416039aAd46` |

Do not expose these as a verified live registry without the registry approval gate. The report does not establish deployment heights, complete ABIs, current proxy targets, current token mapping, actual activity, underlying vault identity or current economic settings.

### State and event discovery clues

The report reproduces events `AggregateDispatched`, `AggregateCanceled`, `AggregateFinalized` and per-participant events, plus shield/unshield material. It mentions partial Unitas execution and cooldown/recovery paths. These are useful search terms for obtaining the ABI and real lifecycle fixtures; they do not justify implementing the PRD's proposed generic Queued → Processing → Claimable timeline. Generic stage labels must be mapped only to verified deployment behavior.

Public getter names listed in the audit include `aggregateState`, `aggregateCreatedAt`, `aggregateDispatchedAt`, `aggregateMinAggregateAge`, `aggregateCallbackDeadline`, `aggregateStep`, and `vault`. Their exact ABI encoding, upgrade version and production reachability remain unverified.

### Privacy inference warning N14

N14 is titled **“Public Settlement Metadata Enables Single-Participant and Differential Privacy Inference.”** It describes address/timing/batch membership and public settlement totals as potential inference channels. It says amount confidentiality does not imply address anonymity or private ingress/egress/TVL. The issue is recorded as acknowledged with project commentary about application restrictions. This is a historical audit finding and response, not an independent assertion that the current protocol has an exploitable unresolved issue.

Product implication: retain the prohibition on participant enrichment, batch-to-wallet joins, reserve differencing and per-wallet confidential timelines. Require a metric-specific disclosure review; do not make a global claim that all amounts, counterparties or TVL are cryptographically invisible. Prefer wording such as “Individual encrypted holdings are not collected by PrimusScope.”

## F2, F3 and F4 scope limits

**Fund SDK**: zkTLS social-account funding, token claim authorization and refunds. Not a vault/yield/owner-private-read SDK. Its README asks integrators to obtain a developer app identity for this different workflow; PrimusScope does not need those credentials for anonymous read-only analytics.

**Primus FHE**: general-purpose low-level cryptographic crates. No confirmed finance wallet authorization or safe browser decryption API in the inspected scope.

**PoR client Unitas**: describes exchange account connectors for proof-of-reserves style data collection. The README lists authenticated account endpoints for Binance, Aster and Bybit. It is not evidence of a public APY/TVL feed, and PrimusScope should not collect users' exchange credentials or reuse private connector responses.

## Recommended feasibility statuses

| Proposed feature | Status now | Next evidence needed |
| --- | --- | --- |
| Finance contract/source directory | Discovery candidate | Confirm live BSC code/proxy state and official identity |
| Public batch state/timing | Plausible, unvalidated | Full versioned ABI, real event lifecycle, reviewed privacy projection |
| Shield/unshield operational counts | Plausible, unvalidated | Exact event semantics; role/dedupe policy; safe aggregation |
| Current/historical strategy APY | Unverified | Official yield source and mathematical definition; historical availability |
| Confidential vault TVL | Unverified and disclosure-sensitive | Reconciliation, ownership attribution and privacy review; no reserve-balance proxy |
| Owner positions/decryption | Blocked on supported integration | Official client auth/decryption API, origin rules, account switching and security review |
| Proof-of-reserves cards | Separate optional discovery track | Authorized public dataset/feed, schema and reuse terms; no private exchange connectors |

## Access and verification limits

The direct Primus docs and dApp hostnames were denied by the configured network policy in the parent research session. No alternate-domain bypass was attempted. Public GitHub sources were accessible through ordinary configured HTTPS Git access.

No live dApp UI inspection, RPC reads, contract bytecode verification, historical log reconciliation, APY query, wallet connection, consent/decryption trial or source-terms approval was completed. This review cannot establish which features are absent from today's Primus dApp. Treat the product's proposed differentiation as a hypothesis pending direct comparison and interviews.

## Follow-up: using official SDKs without confusing their scope

`fund-js-sdk/package.json` identifies the official package as **`@primuslabs/fund-js-sdk`**, repository version **0.1.38** at F2's inspected commit. Its dependency on `@primuslabs/zktls-js-sdk` further fits the social-identity proof funding/claim flow. The package is not needed merely to read finalized public contract events, and integrating it solely to claim official-SDK use would add unrelated transactional surface.

Also inspected `primus-labs/fhe101` at `11985ccee16870c31227fb41d1fea1e4e46f678e`. Its setup/tutorial pages are FHE educational material, including Zama/fhEVM examples. Those examples must not be represented as official Primus FHETransform production wallet authorization APIs.

**Recommendation:** use an official Primus zkTLS SDK for a real optional proof verification or developer integration feature after its API/trust model is validated. Use standard read-only EVM clients for public analytics. Keep private finance integration gated until Primus supplies a supported client package/API, release/version, allowed-origin rules, consent schema and complete decryption trust boundary. No authoritative compatible finance client was established here; do not guess a package name or promise owner reads.

This review does not contact Primus. A useful future team discussion would ask for (1) the authoritative production registry and ABI provenance, (2) supported read-only SDK/API access, (3) safe aggregate publication guidelines and source reuse permissions, and (4) sandbox fixtures. Project interest or using an official SDK does not imply endorsement, co-development, funding or promised support.
