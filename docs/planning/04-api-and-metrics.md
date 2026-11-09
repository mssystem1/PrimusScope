# API and metric contracts

Proposed contract baseline. Examples are schema illustrations, not measurements or deployed Primus API behavior. Implementation should generate OpenAPI and client types from shared schemas and validate the worker/read model against the same definitions.

## Resource identity and time

- A task is identified by `chainId + taskContract + taskId`. Validate bytes32 IDs for the inspected SDK version. Never silently resolve a task ID to the newest contract.
- A 32-byte hex string can be a transaction hash or a task ID. Input classification cannot choose one from its shape alone; search supported scopes and present candidates or require an explicit type.
- Public filters allow only supported chain IDs, registered contracts and enumerated metrics/statuses. No caller-supplied RPC URL, SQL or arbitrary feed URL.
- Use UTC ISO-8601 instants and half-open ranges `[from,to)`. UTC is the default bucket timezone; a display timezone setting does not silently regroup shared data. Partial current buckets are marked.
- All amounts, integer identifiers/block heights and large counts serialize as decimal/hex strings under the schema. Units and token decimals are explicit. No cross-token numeric total without a sourced conversion method.

## Public API surface

Namespace: `/api/v1`. Public analytics has no wallet authentication requirement.

| Method / resource | Purpose | Required behavior |
| --- | --- | --- |
| `GET /overview` | Supported-domain summaries and change annotations | Each component retains its own source, coverage and freshness |
| `GET /registry/contracts` | Approved contracts, versions and capabilities | Distinguish chain environment and support intervals |
| `GET /network/summary` | Requests, reports, supported outcome/fee series | Full scope, range and methodology in response |
| `GET /network/tasks/{chainId}/{taskContract}/{taskId}` | Exact task and sanitized report/state observations | No raw proof subjects or inferred status |
| `GET /network/transactions/{chainId}/{txHash}/tasks` | Zero/one/multiple task mappings | Return all supported matches; no one-task assumption |
| `GET /network/wallets/{chainId}/{address}/tasks` | Public network-task activity | No ownership claim, FHE joins or signature requirement |
| `GET /network/attestors` | Supported registry facts | No fabricated uptime, stake or reliability score |
| `POST /explore/lookup` | Typed public identifier lookup | Bounded JSON `{type, identifier, chainId?, contractId?}`; do not log raw input |
| `GET /finance/vaults` | Supported live vault identities | Enabled only for approved sources |
| `GET /finance/vaults/{vaultId}/metrics` | Approved yield/public operational series | No private amount or misleading TVL proxy |
| `GET /finance/vaults/{vaultId}/batches` | Reviewed public batch states | Actual observed native stages; no participant enrichment |
| `GET /metrics/{metricKey}/definition` | Formula, unit, denominator and caveats | Versioned with the chart definition |
| `GET /sources/{sourceId}` / `GET /status/sources` | Provenance and status | Source/chain delay separate from our indexing delay |
| `GET /exports/metrics.csv` | Exact filtered public series | Same publication policy and as-of as UI |

Search uses a bounded body to avoid accidental raw-query logging; resulting public object links remain shareable. The UI must reject attestation JSON and sensitive content locally rather than send them to public search. Edge/server/error-monitoring redaction still applies to routes containing public identifiers.

Later routes: developer app/event administration and telemetry ingestion with tenant authorization; account synchronization with scoped authentication. No generic private-balance endpoint: an approved private-read feature uses the official client boundary. A verifier payload remains local; introducing any remote verifier would require a separately specified consent/data route and is outside this baseline.

## Metric envelope

Model origin, access, finality, verification, coverage and freshness as independent attributes. A single `VERIFIED` or `evidence_class` badge cannot express them correctly.

```json
{
  "metric": "network.task_requests",
  "definitionVersion": "1.0.0",
  "publicationPolicyVersion": "1.0.0",
  "scope": {
    "chainIds": [8453],
    "contractIds": ["approved-contract-id"],
    "environment": "mainnet"
  },
  "range": {"from": "2026-11-01T00:00:00Z", "to": "2026-11-02T00:00:00Z", "bucketTimezone": "UTC"},
  "unit": "tasks",
  "points": [{"start": "2026-11-01T00:00:00Z", "value": null, "availability": "not_indexed"}],
  "provenance": {"sourceKind": "chain_event", "sourceIds": ["reviewed-source-id"]},
  "accessScope": "public",
  "verification": {"attestationCheck": "not_applicable"},
  "finality": {"status": "unknown", "policyId": "pending-live-validation"},
  "coverage": {"state": "not_indexed", "gaps": []},
  "freshness": {"sourceAsOf": null, "indexedAt": null, "stale": null},
  "snapshotId": null,
  "warnings": ["Schema illustration; no live data queried."]
}
```

Availability values distinguish `available`, `not_indexed`, `unsupported`, `confidential`, `source_error` and `suppressed`. Coverage independently expresses `complete_for_scope`, `partial` or `unknown`; staleness can coexist with an available last-known value. A fully scanned empty range can return zero. An unscanned range cannot.

For totals covering multiple sources, include constituent coverage/watermarks. Do not hide one stale chain behind a green global timestamp. Return source policy and correction/version annotations with historical series.

## Request and response behavior

Proposed initial limits: 256-character identifier input, 100 rows per page, 5,000 plotted points and bounded date ranges appropriate to resolution. Enforce server-side rate and workload limits before RPC/database work. Tune thresholds after measured backfill and query volumes; these are design defaults, not current benchmarks.

Cursor ordering is stable under `(timestamp, chain, contract, object/event key)`. A cursor binds scope, methodology and snapshot/watermark. If a correction invalidates the snapshot, return `SNAPSHOT_EXPIRED` and instruct a refresh rather than silently omitting/duplicating records.

Standard errors include `code`, safe `message`, `requestId`, `retryable` and scope details. Cases include `INVALID_IDENTIFIER`, `AMBIGUOUS_IDENTIFIER`, `UNSUPPORTED_SCOPE`, `NOT_INDEXED`, `NOT_FOUND_IN_COVERAGE`, `SOURCE_UNAVAILABLE`, `RATE_LIMITED` and `SNAPSHOT_EXPIRED`. Use appropriate HTTP status codes and `Retry-After` for throttling. A cacheable covered-not-found response expires with the underlying coverage watermark.

Public responses use short cache lifetimes only where freshness/publication policy permits. Keys contain all filters, environment, contract set and methodology/read-model version. Private/tenant responses are `private, no-store`. CORS does not replace authorization or CSRF controls. Privacy incident feature-disable and cache-purge paths apply to exports and cached pages too.

## Launch metric dictionary

| Metric | Definition | Required source/validation | Do not imply |
| --- | --- | --- | --- |
| Task requests | Distinct canonical task keys recognized from `SubmitTask` | Verified deployed ABI and scanned event coverage | All Primus usage or all SDK calls |
| Attestor report events | Distinct canonical `ReportResult` event observations | Multi-report/retry semantics and canonical event identity | Completed tasks or verified proofs |
| Tasks with a report | Distinct task keys with ≥1 recognized report | Correct request/report join | Full success or all assigned attestors reporting |
| Native task-state distribution | One supported latest state observation per task at a declared as-of | Versioned `queryTask`/event mapping and pinned block | Exact historical settlement time |
| Public interacting addresses | Distinct eligible submitter addresses within scope | Role definition and creation-window coverage | Unique humans or cross-chain identities |
| Reported fee components | Supported fee observations by task/report and token | Token mapping/decimals, repeat report and settlement rules | Realized revenue, net user cost or gas |
| Execution-gas fee component | Receipt `gasUsed × effectiveGasPrice`, once per transaction | Receipt/chain correctness; transaction-to-task relation | Total paid transaction cost on every chain; Base/L2 may have separate L1 data or other fee components requiring a validated chain-specific formula; not a protocol/FHE compute fee |
| Registry activity | Recognized register/update/unregister observations | Live node ABI and native registry semantics | Online nodes, measured uptime or economic stake |
| Public finance operation count | Recognized, deduplicated native operation transitions | Live ABI, lifecycle and publication review | Amount or participant-level financial history |
| Public batch state/latency | Supported stage observations; exact latency only with real source timestamps | Native state machine and safe projection | Guessed progress, private wait or guaranteed ETA |
| Published strategy APY | Official reported rate with rate type, components and observation time | Reliable feed and definition/historical coverage | Realized depositor yield or promised return |
| Historical share return | `sharePriceEnd / sharePriceStart − 1` on comparable public shares | Decimals, fees, rebases and share economics validated | Individual user profit or APR/APY without conversion definition |

No launch metric named universal `proofs_verified`, confidential `wallet_value`, private `profit`, inferred `points`, or total confidential `TVL` is justified by current evidence.

## Outcome and latency methodology

Keep native partial-success states. Define terminal-state semantics from the live supported version and document uncertain states. For a creation cohort, report request count, success, partial success, explicit failure and unresolved/censored counts at the stated observation horizon.

If a rate is useful, name it precisely: **observed successes by horizon T / requests in creation cohort**. Show unresolved share. A **success fraction among terminal outcomes** is a different measure and must show how many tasks were excluded. Never silently divide new traffic by older settlements or count pending as failed.

Latency is submission to a documented terminal timestamp when that timestamp is actually established. A poll only bounds transition time between observations. Report that interval or label observation latency; never replace it with false exactness. Percentiles must state the eligible sample and censored exclusions. Low sample sizes do not support broad reliability claims.

## Exports and proof checks

CSV includes exact scope/filter ranges, UTC basis, units/decimals, source IDs, definition/publication versions, as-of and missing/suppressed flags. Its totals reconcile with UI under the same snapshot. Sanitize string cells against spreadsheet formula injection without altering numeric accounting. Never export suppressed raw values behind a confidential chart.

A local attestation check produces separate statuses for parse/schema, signature, signer/trust source, recipient/context policy and freshness where defined. Include verifier version and check execution details locally. `not_run` and `unsupported` differ from `failed`. No attestation available is not an invalid proof. A valid signature does not certify that the attestation is current, belongs to the viewer, or satisfies a particular application's policy.
