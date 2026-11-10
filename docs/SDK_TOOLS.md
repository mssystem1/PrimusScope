# Official Primus SDK tools — step 3

The implementation has two independent workflows: a local Page Core signature
inspector, and opt-in application diagnostics for that same supported SDK mode.
It does not generate attestations, submit transactions, connect a wallet, or
read encrypted wallet positions.

## Local inspector

Open `/developers/verify`, paste or open a JSON file up to 64 KiB, optionally
enter expected values, then run local checks. Clear private input or leave the
page to discard it. Input and expected values are held in tab memory, never in
storage, URLs, server requests, shared links, or exported reports. Cancel/clear
terminates the worker and prevents stale results from appearing. Clear also
turns diagnostic recording off.

The actual method is
`PrimusPageCoreTLS.prototype.verifyAttestation` from
`@primuslabs/zktls-page-core-sdk@0.2.1`. The package version, npm integrity and
three verification-source hashes are pinned in
[SDK provenance](../data/sdk/page-core-0.2.1.json). The build checks those pins
and bundles a versioned, hashed worker locally; no runtime CDN is involved.

The browser constructor creates `AlgorithmUrls`, which starts remote node
discovery and WebSocket work. PrimusScope deliberately does not construct or
initialize the class. The audited method uses no instance state and is invoked
directly on the official prototype inside an ephemeral Worker. Its response
sets `connect-src 'none'` and `worker-src 'none'`; fetch is also disabled inside
the worker. Proof-generation globals, extension flows and WASM are not loaded.

### Supported wire format and checks

Only the Page Core single-signature format is accepted. It uses the legacy
field `reponseResolve`, string `request.header` and `request.body`, response
entries with string `keyName`, `parseType`, `parsePath`, and one
`{attestorAddr,url}` attestor entry. The returned attestation format is distinct
from SDK request-generation options and other Network/extension schemas.
Unknown fields, multiple signatures, unsigned input, oversized values and
unsupported formats do not receive a signer-match result.

Results separate:

| Check | What it establishes |
| --- | --- |
| Format | Input meets the narrowly supported wire schema |
| Signature recovery | The SDK/ECDSA recovery operation completed |
| SDK pinned signer | Recovered signer matches the address compiled in 0.2.1 |
| Expected recipient | Exact address comparison with a user-provided expectation |
| Expected request | Exact comparisons for the supplied URL and/or method |
| Expected context | Exact nonempty `additionParams` comparison |
| Selected age policy | Browser-clock comparison using explicitly selected seconds/milliseconds and maximum age |

No check is described as a universal verified proof. The SDK pin is
`0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6`, not a live trust-registry or
revocation check. The SDK reads only the first signature and does not authenticate
the attestor list. Its legacy packed encoding concatenates variable-length
strings: field boundaries are not an independent application-authorization
guarantee. Tests demonstrate this encoding ambiguity so an SDK signer match is
never promoted to a general data-integrity, eligibility or authorization badge.

No full zk-proof computation, source-response revalidation, application nonce
store or replay prevention runs here. Contract examples imply Unix seconds,
but the SDK type does not declare timestamp units; freshness is unrun until
the user explicitly selects their application's convention.

The rejection example is self-signed with a public test key and is explicitly
not issued by Primus. It must fail the official SDK pin check. No official
public signed fixture matching that pin was found in the package, repository
test, demo, or contract tests. **A genuine positive production-path validation
remains unverified.** Rejection/source checks and synthetic unit-policy tests
are not presented as that evidence. Users can inspect their own supported
attestations locally without sharing them with PrimusScope or in chat.

## Developer Studio pilot

Open `/developers/apps`, enter a name and allowed HTTPS origin (localhost is
allowed for development), and accept the explicit metadata consent before
creating a project. A browser-owned, opaque, HttpOnly/SameSite=Strict cookie
authorizes management; it is Secure on HTTPS and scoped to the developer API.
There is no linked account or cross-device recovery. Losing the cookie loses
management access; retained projects expire automatically.

Each browser owner may have three active projects. Projects and events expire
after seven days. Each project is capped at 1,000 retained events; batches have
at most 25 events and 32 KiB. Registration is limited to ten requests per UTC
day and requester bucket. The server stores a daily keyed hash for that rate
limit, not the requester IP. Counts/outcomes are an opt-in client-reported
sample, separate from public Network statistics and cryptographic evidence.
Test events are excluded from the default summary. Median/p90 durations require
at least five eligible verifier invocations and reflect local inspector/device
execution, not protocol or network latency.

An ingest key is displayed once. It can submit events to its project, but
cannot read or administer it. Browser-embedded ingest keys are not treated as
secrets that make reports authoritative. Rotate revokes the old key. Clear
deletes events; Delete removes the project, key and events. Exports contain
only app-owned sanitized metadata and never keys, cookies or proof input.

### Exact event allowlist

Only these ten fields are accepted: `eventId` (random UUID), `sdk`, `version`,
`operation`, `durationMs`, `outcome`, `sdkInvoked`, `isTest`, `errorCode`,
`runtime`. Package/version/operation/runtime are pinned to the supported
browser verification mode; outcomes/error codes are finite enums and duration
is bounded. Server receipt time is added separately. Extra/nested fields,
proof contents, wallet/recipient identifiers, signatures, URLs, cookies,
headers, source responses, raw errors and caller timestamps are rejected.

Reporting from the local inspector is off by default. Explicitly choose an
owned project to enable it. Only the fixed diagnostic projection crosses the
network boundary; proof input and expected values never enter the API call.

For an integrating app, copy
[the measured SDK adapter](../examples/primus-verifier-diagnostics.ts), install
the pinned official SDK, and call the returned verifier. Reporting defaults to
off. Enable it only after consent and project configuration. It invokes the
real official method, measures its duration and reports safe outcomes without
serializing SDK inputs or exceptions. A telemetry failure does not change the
verification result; missing reports remain missing samples.

### Private API

| Method | Path under `/api/v1/developer` | Authorization |
| --- | --- | --- |
| GET / POST | `/apps` | Owner cookie for reads; same-origin consented registration for creation |
| GET / DELETE | `/apps/:appId` | Owner cookie; CSRF origin check for deletion |
| POST | `/apps/:appId/rotate` | Owner cookie + same-origin request |
| POST | `/apps/:appId/record` | Owner cookie + same-origin request; local-inspector metadata only |
| POST / OPTIONS | `/apps/:appId/events` | Scoped bearer ingest key for POST; registered-origin CORS for browser clients |
| DELETE | `/apps/:appId/events` | Owner cookie + same-origin request |

Same event ID and same event metadata are idempotent. Conflicting reuse is
rejected atomically. Origin validation/CORS does not replace owner or bearer
authorization. App IDs alone do not authorize reads or writes. Responses are
`private, no-store`; unknown/unauthorized projects do not disclose their data.

## Hosted isolation and retention

The additive `primusscope_diagnostics` schema is independent of the public
publication and collector checkpoint tables. The web uses a new restricted
`DIAGNOSTICS_DATABASE_URL`; its role has schema usage and explicit function
EXECUTE permissions, no table reads/writes and no public-publication access.
SECURITY DEFINER functions enforce owner/key checks, quotas, strict SQL-level
event types, deduplication and row/advisory locks. PUBLIC execution is revoked.

`DIAGNOSTICS_RATE_LIMIT_SECRET` is server-only and configured alongside that
URL. No Primus app secret, wallet key, new paid API, or managed cloud publication
is required. Administrative Neon credentials are used only by the bootstrap
script; runtime roles stay separated.

The existing 15-minute collector receives permission only to prune expired
diagnostic metadata. It prunes after chain collection and reports
`X-PrimusScope-Diagnostics-Retention: pruned|unavailable`. A retention failure
does not roll back completed chain work. Expired events are hidden immediately;
physical deletion occurs at the next successful prune (not a guaranteed time
during collector outages). Project creation also prunes old data.

## Validation and remaining evidence

Tests exercise the actual SDK's known-negative signature path, unsupported,
malformed/tampered inputs, policy comparisons, no constructor/network/logging,
private-value-free reports, exact SQL/API allowlists, owner isolation, CORS,
CSRF, key revocation, quotas, physical retention and deletion. PGlite executes
real SQL and role grants. Browser checks cover the worker CSP, no proof data in
traffic/storage/URLs/exports, clear/reset, responsive layout and accessibility.
Hosted checks create temporary projects and remove them afterward. Live
credentials/cookies are excluded from traces and screenshots.

The genuine signed positive fixture remains the explicit unverified gate.
Package metadata does not include a license field/LICENCE file; provenance
records that observation. SDK use is not official endorsement or certification.
