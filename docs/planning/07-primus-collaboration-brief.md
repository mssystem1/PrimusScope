# Proposed Primus Labs collaboration brief

Prepared for possible future use; **not sent**. No partnership, endorsement, certification, grant or support commitment is asserted. Official SDK adoption is useful technical alignment, not a promise of team support.

## The proposal

PrimusScope is an independent, read-only analytics and explainability companion for Primus. It would help users understand public network tasks, researchers reproduce source-backed trends, developers diagnose their own SDK integrations, and owners inspect private positions only through a supported official client flow.

The product complements the transaction dApp: it links to the official Primus application for deposits, redemptions, claims and sends. It does not custody assets, request approvals or reconstruct confidential values.

The strongest initial contribution would be a tested, source-documented task explorer and compatibility matrix, followed by a small official-SDK verification/diagnostics integration. Public metrics would distinguish task requests, per-attestor reports, native task outcomes and independently checked attestations. This avoids misleading “all proofs” statistics.

## What we could contribute

- Reproducible contract/source registry and versioned metric definitions.
- Read-only task fixtures and explicit handling of partial outcomes and SDK/ABI upgrades.
- Privacy-preserving opt-in SDK error/duration diagnostics with a documented event schema.
- Honest source coverage, status, correction and attribution patterns for ecosystem analytics.
- Clear feedback on integration documentation, schema compatibility and sanitized failure cases.

These are proposed outputs. A planning document does not mean those integrations already run.

## Specific technical requests

1. Confirm supported SDK packages/versions for Network browser/backend, enterprise and Lightweight Web modes; provide verification-only entry points and a release-notification path.
2. Confirm production task/node addresses, deployment blocks, implementation histories and ABI versions, including discrepancies between Ink/startup documentation and SDK constants and the BNB task deployments.
3. Explain native success/partial-success/settled/failure semantics, repeated attestor reports, timeouts, fee accounting and refunds. Which public sources support historical terminal outcomes?
4. Provide sanitized positive/negative attestation fixtures, supported schemas, trust-anchor rotation guidance and the division between signature verification and recipient/context/freshness policy.
5. Confirm whether payloads can be verified entirely client-side without transmission to RPC/API, and how SDK built-in reporting/logging can be configured for privacy-sensitive tools.
6. Provide the canonical Confidential Finance contract/strategy registry, supported public metrics and any reliable current/historical yield feed. Confirm safe publication expectations for batch metadata and capital aggregates.
7. Confirm whether an official third-party owner-authorized FHE read/decryption integration exists, including origin restrictions, scope, session lifetime and private-material handling. We will not invent one.
8. Clarify SDK/binary/ABI and dataset redistribution terms, API limits and brand attribution. Identify the appropriate technical collaboration or support channel.

## A useful first demonstration

Bring one real production task from source evidence through a read-only API to the deployed explorer; show replay/correction behavior, proper report/outcome separation and the source metadata panel. Demonstrate one authentic supported SDK flow only after its runtime/privacy checks pass. If Finance is ready, show one validated public vault series without confidential-wallet enrichment.

Support outreach should show a small working contribution and precise questions. It should not describe the project as official or claim that using an SDK creates endorsement. The user can authorize outreach later; no team communication is part of this planning task.
