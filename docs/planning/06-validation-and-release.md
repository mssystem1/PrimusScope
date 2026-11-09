# Validation and release plan

Status: proposed implementation and release requirements, 8 November 2026. This is a planning artifact. No application has been built, deployed, or tested against these gates. The document review and repository inspection do not count as application test execution.

The user requires Vercel deployment followed by UI/UX, API, workflow and end-to-end testing. Fulfil that requirement with tests against the actual deployed application, supported by deterministic data and isolated infrastructure tests. Preserve separate evidence for previews, staging and production. A working local build or an attractive screenshot is insufficient release evidence.

## 1. Before implementation: establish testable facts

Complete a source feasibility register before committing to individual numerical features. Each entry records primary source, accessed date, contract or API identity, chain and environment, deployment block where known, ABI/package version and hash, observable fields, publication permission, privacy constraints, expected cadence, and validation status. Distinguish source-documented, code-inspected, runtime-observed and still-unknown assertions.

Discovery exit gates:

1. Identify one network contract with deployed code and a reproducible task lifecycle. Match official documentation, ABI, implementation history and real finalized observations. A task identifier is `(chainId, taskContract, taskId)`; chain plus ID alone is not necessarily unique.
2. Validate how the deployed contract records outcomes. SDK-source research identifies requests with multiple attestors and per-attestor `ReportResult` events; those events must not be counted as independent completed tasks. The observed SDK exposes additional native task states through `queryTask`. Confirm their deployed semantics before deriving success metrics. A current-state query alone cannot establish historical transition times.
3. If Finance is included in the release, identify one useful, publishable finance dataset. Audit/document addresses are discovery seeds until bytecode, source, version, actual events and semantics have been checked. A finance-source discovery failure gates that capability; it does not justify synthetic APY, guessed batches or confidential TVL.
4. Define each launch metric's formula, units, denominator, time windows, finality policy, exclusions and unknown-data behavior. Explain why its public presentation preserves financial confidentiality.
5. Trace a supported SDK flow using the official package and compatible contract version. Record what is demonstrably integrated and what remains conditional. Plan client-side verification and owner decryption as separate capabilities with separate prerequisites.

The deliverable is a reviewed evidence register and executable-fixture specification. If Finance remains unavailable, a release that satisfies the R1 gates is explicitly a Network beta. It does not satisfy the R2 Finance + Network beta gate. A preliminary slice that has not passed R1 remains a technical preview.

## 2. Environments and deployment boundaries

Deploy the Next.js web interface and bounded API handlers to Vercel. Run continuous indexing, historical backfill, replay and durable scheduled work in an independently managed worker service. Use managed Postgres with migrations, backups and an appropriate connection pooler. Verify actual selected plan/runtime limits during implementation rather than relying on generic serverless assumptions.

| Environment | Purpose | Data and write boundaries |
| --- | --- | --- |
| Local/CI | Unit, contract and integration tests | Disposable database; deterministic fixtures; no production credentials |
| Vercel preview | Review the exact candidate web/API deployment | Isolated staging data or explicitly labelled fixtures; no worker per preview writing shared production cursors |
| Staging | Full ingestion and failure-recovery validation | Dedicated worker, database, source settings, telemetry tenant and test accounts |
| Production | Real public service and read-only acceptance checks | Restricted credentials; reviewed registry; controlled worker; no fault injection |

Production secrets must be scoped to production. Preview configuration must not expose them through build output, browser bundles, logs or source maps. Deploy database migrations once through a controlled step; do not run concurrent migrations in web requests. Prefer additive schema changes that tolerate an older frontend during rollback.

Before the first deployment, verify Vercel account/project access, database and worker hosting, source/RPC access, domain configuration where applicable, and optional observability services. Request missing values through secure settings. This planning phase does not require deployment secrets or secret values in chat.

## 3. Test layers and acceptance criteria

### Pure metrics and schemas

Use unit tests for deterministic transformations, semantic state mapping and API validation. Cover 6/8/18-decimal assets, uint256-sized integer values, rounding, base versus reward yield, APR versus APY, fees, half-open UTC time intervals, partial buckets and invalid inputs. Amounts remain integer base units until explicitly scaled; JSON transports decimal strings.

Test unresolved requests separately from explicit failures. Validate creation cohorts, observation horizons and censored outcomes before publishing completion rates. Do not collapse partially successful, failed and pending states unless an explicitly versioned definition justifies the grouping. Gas, protocol fees and rewards are separate quantities; multi-chain token amounts cannot be added without a documented conversion.

Test the full availability model: complete zero, unsupported, encrypted, not yet indexed, partial coverage, stale and source error. Unavailable data must survive API serialization, chart rendering, export and cached responses without becoming zero.

### Ingestion and database integration

Use a real disposable Postgres instance and bounded recorded event fixtures. Verify duplicate logs, reordered results, repeated attestor reports, task ID collisions across contracts, empty block ranges, receipt-enrichment retries, worker crash/resume and lease ownership. Replaying an already indexed range must leave canonical counts and totals unchanged.

Simulate short and deeper reorgs in isolated fixtures or a controlled test chain. Orphaned events must stop contributing; replacement events must contribute exactly once. Test ABI changes at implementation boundaries, source schema drift, missing RPC ranges, rate limits and source recovery. Persist gap coverage rather than merely advancing the highest seen block.

Validate chain-specific finality policies. A fixed lookback is not universal finality, particularly for L2 sequencing versus settlement. Monitor finality delay separately from indexer delay. Reconciliation should compare a known, bounded event set against its source and verify aggregate agreement before expanding historical coverage.

### API and privacy boundaries

Validate schemas, query limits, deterministic cursor ordering, complete pagination, chain/contract disambiguation, typed errors and source metadata. Check malformed searches before RPC work, rate limits, cache keys, ETags and exact export filters. Reject arbitrary URLs, raw RPC proxy requests and unapproved contract identifiers.

Inspect serialized responses, HTML, browser network requests, error reports, database rows and exports for forbidden private values. Check search/query leakage through access logs, referrers and monitoring. Public read models must use explicit field allowlists. Public finance filters and repeated queries must not defeat amount suppression or reveal an individual's hidden activity.

For later private features, test wallet/account/chain switching, expiry and disconnect cleanup. Confirm official authorization material and decrypted values never reach PrimusScope servers, telemetry or persistent browser storage unexpectedly. SIWE account login is not FHE decryption permission. For developer telemetry, verify app-scoped authorization, forged events, deduplication, retention/deletion and cross-tenant isolation.

## 4. Browser, workflow and UI/UX matrix

Run Playwright against the candidate's immutable Vercel deployment URL, not only a local server. Separate fixture-driven browser checks from read-only live-source canaries. Both are necessary: deterministic tests expose regressions, while canaries establish that the real integration currently works.

| ID | Journey | Required outcome and evidence |
| --- | --- | --- |
| E01 | Anonymous overview → network chart → source panel | No wallet prompt; correct filter scope; API-backed series; definition, source, finality and freshness visible |
| E02 | Known transaction → task detail → source explorer | Correct chain/contract/task mapping; native outcome explained; per-attestor report distinct from task outcome |
| E03 | Ambiguous task ID or transaction matches | Explicit disambiguation; unsupported/unknown/indexing-gap states differ; no guessed result |
| E04 | Vault directory → detail → official action | Only evidenced finance data; APY labelled by source; correct unavailable behavior; vetted official-domain outbound link |
| E05 | Filter and export | CSV reconciles to displayed filters and data; units, time basis, methodology and source included |
| E06 | Source outage or delayed indexing | Last-known data retains its timestamp; stale/partial label appears; no false zero or protocol-failure claim |
| E07 | Local attestation verification, when enabled | Genuine supported input passes the defined check; tampered, unsigned, wrong-context and unsupported input never receives a misleading verified badge |
| E08 | Private workspace, when enabled | Explicit consent; correct owner scope; clean account switch/disconnect; no private payload in PrimusScope traffic or logs |
| E09 | Developer observability, when enabled | Sanitized event reaches only its app; latency/error summary matches fixtures; forbidden payload rejected |
| E10 | Public wallet lookup and returning workspace | Anonymous address lookup shows only covered public network tasks, with no ownership claim or confidential-finance joins; no signature or wallet prompt |
| E11 | Save public object/view → return → inspect changes | Device-local preference persists; changes use the last trustworthy watermark; corrections invalidate misleading deltas; clear/reset works; private values, permits and proof payloads never enter storage or share URLs |

For every launched page test loading, complete empty, partial, stale, encrypted, unavailable, validation-error and server-error states. Snapshot responsive layouts at 360/390/768/1024/1440px. Verify chart tooltips and data-table alternatives, keyboard navigation, focus visibility, modal focus return, reduced motion, colour-independent status cues, touch targets and zoom/reflow. Use automated accessibility checks plus manual keyboard and representative screen-reader review; automated checks alone do not establish WCAG conformance.

Conduct a human usability pass around concrete tasks: finding a task outcome, explaining why an APY is stale, identifying chart coverage, and finding the original source. Record completion, confusion and corrective changes. These findings are UI/UX evidence, distinct from screenshot comparisons and code-level assertions.

## 5. SDK authenticity and verification claims

Use official Primus packages from authoritative registries/repositories, pin versions and lockfiles, preserve integrity checks, and document SDK mode, supported environment and actual invoked APIs. Test selected integration paths against their documented inputs and outputs. Importing an SDK, displaying a logo or invoking a mock is insufficient evidence of integration.

For cryptographic verification record the implementation/version, trust anchor, signed context and precisely which checks ran. A task settlement event does not prove an attestation valid. A valid signature does not establish freshness, business eligibility, or every possible interpretation of the subject's data. Check replay/context requirements where the supported scheme requires them. Unknown or unsupported formats remain unknown or unsupported.

Keep real proof/authorization payloads out of public fixtures and diagnostics. Use appropriately consented, minimized test inputs or official examples. Browser proof generation or private reads may require external prerequisites; mark those tests blocked rather than substituting mocks and claiming live success. SDK integration does not imply official endorsement, certification, partnership, grant eligibility or guaranteed recognition.

## 6. Release sequence and evidence record

1. **Candidate checks:** pin commit, registry, methodology and migration versions; run build/type checks and required unit/integration/API suites. Inspect failing checks and classify setup problems separately from application defects.
2. **Staging deployment:** apply migration, start controlled worker, verify readiness and coverage, then deploy the Vercel candidate. Run browser/API workflows, accessibility checks, isolated outage/recovery exercises and performance measurements.
3. **Live-source acceptance:** verify a known finalized network task and each launch finance source through the deployed API/UI. Document expected source records, observed results and coverage. No passing fixture can substitute for this gate.
4. **Production release:** deploy the verified candidate and compatible schema/registry versions, confirm domain/TLS/configuration, then run non-destructive workflow smoke checks on the actual production URL. Inspect worker lag, API errors and missing frontend assets separately.
5. **Observe and recover:** monitor data freshness, decoding failures, source incidents and API health. Roll back the web release or disable an affected metric when necessary; database corrections require their own reviewed replay. Verify cache invalidation after a privacy/data incident.

Fault injection, manipulated reorgs, malicious telemetry fixtures and destructive load tests belong in isolated staging. Production validation uses bounded read-only requests and public-source checks. Test objectives can all be covered without changing public chain state or risking live users' confidential data.

Maintain a release report with commit and immutable deployment URL/ID, dataset and registry versions, test run timestamps, browser/device targets, executed command or test ID, expected/actual result, attachments and remaining limitations. Report passed, failed, skipped, expected failure, blocked and unrun separately. Record planned tests as planned until execution evidence exists.

Launch requires all enabled P0 workflows to pass, no unresolved privacy exposure or fabricated-data behavior, and an operations owner/runbook. SLOs are targets until measured under declared dataset size, cache state, region and concurrency. A missing optional integration may remain gated; a broken required workflow blocks the corresponding release claim. Re-run the affected suites after meaningful changes, then repeat production smoke against the final deployment.
