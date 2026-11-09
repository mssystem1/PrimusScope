# PrimusScope network/task/proof feasibility review

Research date: 8 November 2026. Planning research only; no Primus SDK code executed, transactions sent, or live RPC deployment verified. Direct Primus docs/dApp hosts were policy-denied in the parent task. Public official GitHub repository sources were fetched read-only.

## Sources pinned in this review

| Ref | Official repository and exact commit | Most useful files |
|---|---|---|
| N1 | [primus-network-startup @ 74f25824365f4ccdb9e6b9fe5cda9b682fb321ab](https://github.com/primus-labs/primus-network-startup/tree/74f25824365f4ccdb9e6b9fe5cda9b682fb321ab) | README supported-chain table and registration guide |
| N2 | [network-core-sdk @ ec157e816d108a6fabdd42cb3a83375618c217e0](https://github.com/primus-labs/network-core-sdk/tree/ec157e816d108a6fabdd42cb3a83375618c217e0) | src/config/taskAbi.json, nodeAbi.json, constants.ts; src/types/index.ts; src/classes/TaskContract.ts; src/index.ts |
| N3 | [zktls-contracts @ e14c7b1ce35c6603ffa9393978e224998a41859b](https://github.com/primus-labs/zktls-contracts/tree/e14c7b1ce35c6603ffa9393978e224998a41859b) | src/PrimusZKTLS.sol; src/IPrimusZKTLS.sol; README |
| N4 | [zktls-att-verification @ c5f99a42f6ab3a8913dabdcac360a2be6429e945](https://github.com/primus-labs/zktls-att-verification/tree/c5f99a42f6ab3a8913dabdcac360a2be6429e945) | README; src/attestation_data.rs; examples/attestation_example.rs |
| N5 | [primus-public-resources @ 108dc335150efe8e40e9eb765f6bf8c6e2d11446](https://github.com/primus-labs/primus-public-resources/tree/108dc335150efe8e40e9eb765f6bf8c6e2d11446) | Only README and brand-kit image in inspected checkout; not a chain data/ABI registry |

These are source-confirmed claims, not proof the same ABI/address is currently deployed or active. The sources' example tests were read only and do not establish successful live tests.

## Findings that materially change the PRD

1. A usable SDK-distributed task ABI and node ABI exist (N2). Implementation need not invent event names, but must still verify each deployed proxy/implementation/version, historical ABI range and event sample.
2. Task outcomes are richer than a simple completed/failed split. SDK TaskStatus is INIT=0, SUCCESS=1, PARTIAL_SUCCESS=2, PARTIAL_SUCCESS_SETTLED=3, FAILED=4 (N2 src/types/index.ts). Model raw native state plus a documented normalized product state, and retain partial success. Do not invent cancellation stages because a UI mock has one.
3. The ReportResult event is per attestor and contains no success/status field. Counting reports as completed proofs or tasks would be wrong. The SDK queries queryTask(taskId) and polls taskStatus; outcome ingestion may need block-pinned state snapshots alongside logs. A read today does not reconstruct an arbitrary historical state without archive access or validated event semantics.
4. One SubmitTask includes attestors[]. Multiple reports may belong to one task. Canonical task identity is (chain ID, task contract address, task ID), with attestor reports stored beneath it. Both API and routes must carry task contract identity or resolve through a stable globally unique registry ID; chain+task ID alone becomes ambiguous across contract replacements/deployments.
5. The PRD chain list is incomplete relative to current SDK source and inconsistent across repositories: N1 lists Ink but N2 SDK constants do not; N2 adds BNB mainnet/testnet task/node addresses absent from the PRD. Treat all as discovery seeds, not automatic supported live coverage. BNB zkTLS task addresses are not BNB confidential-finance addresses.
6. Signature verification is not semantic validation. The inspected Solidity implementation is external view and emits no verification event; it checks a recovered signature against configured attestors. Although comments mention expiry and consistency, the inspected function does not implement an explicit age/expiry policy. The product must expose exactly which checks ran, trusted signer source, verifier version, payload digest, supported schema, requested domain/context and freshness checks independently.
7. SDK/network attestations and legacy Solidity attestations do not have identical schema: network TaskResult attestation has request arrays and responseResolve arrays; the inspected zktls-contracts Attestation uses a singular request and field spelling reponseResolve. A universal JSON uploader cannot route everything to one unversioned parser/verifier.
8. The Rust verification examples can consume private_data including AES key and decrypt message content. This is not a safe server upload recipe. A local verifier must be sandboxed client-side, schema/version constrained, dependency-reviewed, size/time bounded, and free of payload logging. Browser-compatible official verifier support remains a discovery item; a Rust example alone does not establish WebAssembly integration.

## Exact ABI observations (N2)

### Task events

- SubmitTask(submitter address, taskId bytes32, templateId string, attestors address[], submittedAt uint64)
- ReportResult(attestor address, taskId bytes32, user address, tokenSymbol uint8, primusFee uint256, attestorFee uint256)
- WithdrawBalance(user address, tokenSymbol uint8, unnamed uint256 amount, settledTaskIds bytes32[], taskStatuses uint8[])
- CallbackFailed(taskId bytes32, callback address, reason string)
- Initialized and OwnershipTransferred lifecycle/administration events

The visible ABI does not provide a generic TaskCompleted/TaskFailed event. CallbackFailed is not proof failure. WithdrawBalance can carry multiple task IDs/statuses. Dynamic template IDs, callback reasons and attestation request/data fields may contain sensitive or hostile content; do not render or index arbitrary strings as trusted public taxonomy. Fee sums need tokenSymbol resolution/decimals by contract version, settlement semantics and duplicate/reorg handling; never add ETH/BNB/HSK/ERC20 raw integers into one numeric total.

### Relevant reads

- queryTask(taskId) returns templateId, submitter, attestors, taskResults, submittedAt, taskStatus, tokenSymbol, callback.
- queryUnsettledTasks(address, tokenSymbol, offset, limit)
- taskTimeout()
- queryLatestFeeInfo(tokenSymbol)
- queryRecipientTaskResults(...) and verifyTaskResult(...) are present in ABI; verify exact semantics before using them as proof validation.

SDK submitTask is a value-moving workflow, with ERC20 approval for non-ETH token payment where configured. PrimusScope should not call it simply to populate analytics. A read-only explorer can work from historical events/state.

### Node ABI

NodeRegistered, NodeUnregistered, AttestorUpdated, RecipientUpdated, MetaUrlUpdated, UrlsUpdated, VersionUpdated, NodeTaskStatusUpdated, WhitelistEnabled/Added/Removed, TaskerUpdated exist. SDK getNodeInfo returns registry status, owner/attestor/recipient, metadata URLs, creation time, failure/success bitmap/counters and last failure timestamp. These are protocol-reported/registry facts, not measured node uptime, stake or independent reliability. Arbitrary metadata URLs need an allowlisted fetch strategy, SSRF controls, HTML/text sanitization and safe image handling; do not poll every node endpoint to imply uptime without protocol agreement.

## Address seeds corroborated in official source

| Chain | Task contract | Provenance |
|---|---|---|
| Base 8453 | 0x151cb5eD5D10A42B607bB172B27BDF6F884b9707 | N1 README and N2 constants |
| Base Sepolia 84532 | 0xC02234058caEaA9416506eABf6Ef3122fCA939E8 | N1/N2 |
| HashKey testnet 133 | 0x6588a24D34C881cF10c8DA77e282f6E1fBc262C7 | N1/N2 |
| HashKey 177 | 0x1c5D0d5e0a3e0a5c9B0cDcF5C25A892281e4cd04 | N1/N2 |
| Ink 57073 | 0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE | N1 only in inspected sources |
| BNB testnet 97 | 0x05e55E36C33324C81e163125d36Ac26f585ACa8e | N2 only in inspected sources |
| BNB 56 | 0x7be04E0a97BD34aBBf510D963d55B6B89C37673d | N2 only in inspected sources |

Base node registry seed is 0x9C1bb8197720d08dA6B9dab5704a406a24C97642 (N1/N2). No live bytecode, deployment blocks, event activity or current proxy implementation was independently verified in this review. Prioritize Base as the narrow validation target, with production/testnet separated.

## Recommended launch feasibility matrix

| Capability | Current evidence | Readiness decision |
|---|---|---|
| Network request count | SDK SubmitTask ABI available | Feasible after live ABI/address/event/finality validation |
| Request→attestor-report timeline | SubmitTask/ReportResult available | Feasible; label reports accurately |
| Completed/partial/failed task distribution | Native SDK status and read exist | Needs validated block-aware state adapter; not event count shortcut |
| Per-task fee components | ReportResult fields exist | Needs token mapping, version and settlement/retry/reorg semantics |
| Attestor registration/history | Node ABI and read fields exist | Feasible after live validation; no uptime/stake claims |
| Universal ecosystem proof total | Public contract mode is subset, verifier is view | Unsupported; do not promise |
| Local attestation verifier | Official Solidity/Rust code exists | P1 after schema/trust/privacy/browser feasibility checks |
| Source-backed task search | bytes32 IDs and event/read model exist | MVP candidate; include contract in identity |
| Wallet task activity | Inherently public network submitter field | MVP candidate as anonymous read-only lookup; local preferences require no auth, later account synchronization can require it; no cross-domain private profiling |

## Discovery acceptance before building production analytics

- Resolve one Base seed against live bytecode/proxy implementation, official source, ABI hash and deployment block.
- Capture one real request and all per-attestor reports; read native state at a pinned finalized block and explain status/fees without assumptions.
- Include partial success, refund/withdrawal, callback failure, multi-attestor report and no-report fixtures; classify absent evidence separately from failure.
- Inspect actual TaskResult/attestation field privacy before exposing payloads, URLs, template strings or raw calldata.
- Verify each metric using a golden dataset with per-task and per-report counts distinct and token units explicit.
- Pin verifier schema/trust anchors; test a valid signature with wrong domain, recipient, stale timestamp and wrong context. Show individual check results rather than a single overbroad “proof valid”.


## SDK integration strategy for ecosystem usefulness and a team collaboration proposal

Using an official SDK is worthwhile where it solves an actual user problem; dependency installation alone does not make the analytics accurate or imply Primus endorsement. Keep anonymous dashboards read-only, with no attestation generation, wallet signing or native proof engine in their critical path.

### Official package candidates confirmed in source or registry

| Package | Observed version on 8 November 2026 | Appropriate use | Runtime boundary |
|---|---|---|---|
| `@primuslabs/network-js-sdk` | npm latest 0.1.11 | Optional browser network task SDK integration or developer instrumented sample; wraps network submit/attest/poll workflows | npm README uses window.ethereum; depends on `@primuslabs/zktls-js-sdk`. Read-only MVP does not call submit or withdraw. |
| `@primuslabs/network-core-sdk` | source/npm 0.1.19 | Backend application integration example and source of task/node ABI/types | Includes native install script, platform libraries and algorithm workers. Separate trusted worker runtime if generating proofs; do not bundle into Vercel request handler merely for indexing. |
| `@primuslabs/zktls-js-sdk` | source/npm 0.3.15 | Enterprise/browser attestation and compatible local signature checking | Source communicates with PADO browser extension via window messages; separate mobile branches exist. App secret stays server-side; do not follow any browser-secret shortcut. |
| `@primuslabs/zktls-core-sdk` | source/npm 0.3.9 | Enterprise/backend proof creation; not a network indexer | Native install/algorithm runtime. `init(appId, appSecret?, options)` and `startAttestation` APIs observed; app-secret material remains scoped server-side. |
| `@primuslabs/zktls-contracts` | repository inspected; package release not verified | Official EVM verifier interface/source and schema-specific trust checks | `verifyAttestation` is view; no verification event. Ordinary eth_call transmits its arguments to RPC, so do not submit sensitive local proof data to an RPC and call that fully local verification. |

Versions above are observations, not chosen implementation pins; select the supported version with the Primus team and lock it after compatibility review. Registry URLs: https://registry.npmjs.org/@primuslabs%2fnetwork-js-sdk , https://registry.npmjs.org/@primuslabs%2fnetwork-core-sdk , https://registry.npmjs.org/@primuslabs%2fzktls-js-sdk , https://registry.npmjs.org/@primuslabs%2fzktls-core-sdk . No explicit license field was present in these inspected package metadata, and no LICENSE file was retrieved at the tested zktls-js/core main paths. Clarify package/ABI redistribution and commercial usage terms; do not infer a license from public availability. Solidity source has SPDX MIT, but that is not a blanket license for all SDK artifacts.

Additional pinned sources:
- [zktls-js-sdk @ 0265962b1d4b8e9db56ff7b1e9120a0ad5235978](https://github.com/primus-labs/zktls-js-sdk/tree/0265962b1d4b8e9db56ff7b1e9120a0ad5235978), especially src/index.ts and package.json.
- [zktls-core-sdk @ 24b1944f1c53154420649ae9cbe13865d41ab6de](https://github.com/primus-labs/zktls-core-sdk/tree/24b1944f1c53154420649ae9cbe13865d41ab6de), especially src/index.ts and package.json.
- Network-js npm metadata points at `primus-labs/primus-network-sdk`, but a read-only clone returned Repository not found. The public package exists; source repo accessibility/support needs clarification. Its README has an inconsistent bare import in one example, so use package export metadata and a supported current quickstart rather than copy examples untested.
- A distinct Lightweight Web SDK package/API was not verified in available public sources. Do not equate it with extension SDK or promise extension-free proof creation. Ask the team for its current official package/entry point, supported browsers and authentication model.

### Concrete integration sequence to propose

1. Build an SDK/schema compatibility matrix and real Base task fixture set, with official ABI/source attribution and independently tested event meanings. Useful to Primus without forcing new transaction features on PrimusScope.
2. Add a focused local “Inspect attestation” tool after SDK support/privacy validation. Separate Signature check / trusted signer / recipient / source policy / timestamp policy / task settlement into individual results. Source `verifyAttestation` methods recover a signature against a configured address; a true return is not a complete semantic proof-validity verdict. No raw payload upload, event logging or permanent server storage.
3. Publish an optional developer telemetry adapter wrapping public SDK lifecycle boundaries, using a strict allowlist and a privacy preview. Record sdk package+version, request mode, coarse error code and duration; do not monkeypatch browser networking or serialize SDK callback arguments. SDKs have their own event-reporting paths and may log sensitive context, so audit actual installed version behavior before claiming no outbound sensitive data.
4. Offer reproducible read-only example dashboards and source-backed API examples. Keep separate developer-reported telemetry from on-chain counts. A small supported integration can be more useful than importing every SDK.
5. Bring the working read-only slice, schema compatibility report, anonymized failure taxonomy and privacy controls to a proposed collaboration discussion. Team approval/endorsement remains optional and unconfirmed; no outreach has been performed.

### Questions prepared for the Primus team (no contact sent)

- Which SDK packages and versions are currently supported for Network browser, Network backend, enterprise and Lightweight Web modes? Which APIs may change and what release-notification channel exists?
- Can you confirm current mainnet task/node deployment addresses, proxy implementations, ABI versions/deployment blocks and the Ink-versus-SDK-constant discrepancy? Are BNB zkTLS task deployments public production integrations?
- What exactly determines SUCCESS/PARTIAL_SUCCESS/PARTIAL_SUCCESS_SETTLED/FAILED? Can ReportResult ever occur more than once per attestor/task, and how do fees/refunds settle?
- Is there an official event or stable public read for terminal outcomes, with historical block access requirements and supported timeout interpretation?
- Which attestation schemas and signer/trust-root rotations should a local verifier support? Which domain, recipient, timestamp and context checks remain the integrator’s responsibility?
- Is there a browser-safe verification-only SDK entry point, and an official sanitized fixture set including negative cases? Can a cryptographic check run without sending payloads to an RPC/API?
- What is the recommended opt-in telemetry lifecycle hook/error taxonomy? Can SDK built-in reporting and console logging be configured to satisfy a no-payload-logging contract?
- What are the licenses/terms for SDK binary use, ABI redistribution, public analytics/CSV/API and brand attribution? Is there a collaboration/support process for an independent ecosystem tool?
