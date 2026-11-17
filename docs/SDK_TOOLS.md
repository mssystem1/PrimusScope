# Official Primus SDK tools — task 3

Task 3 provides local attestation checks and an opt-in Developer Studio. No
wallet, Primus app secret, extension, transaction or proof-generation service
is needed for these supported workflows.

## Inspect an attestation

Open `/developers/verify`, choose the SDK that issued the attestation, then
paste or open a JSON file up to 64 KiB. Core is the default. Run local checks;
optionally compare the expected recipient, exact request URL/method, signed
context and age. Choose timestamp units explicitly before checking age.

| Profile | Pinned production signer | Implementation |
| --- | --- | --- |
| Core 0.3.9 | `0x5Ed3176045F68617B0958a61ac1868875C98C14d` | Unchanged official verification method and encoding helpers, isolated from the Node/native runtime |
| Legacy Page Core 0.2.1 | `0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6` | Official `PrimusPageCoreTLS.prototype.verifyAttestation` without construction or initialization |

Core is a verification-only extraction from the maintained official
`@primuslabs/zktls-core-sdk@0.3.9`, not a claim that its complete Node/native
package supports browsers. The unchanged method block, helper/environment
files, npm integrity and source hashes are pinned in
[Core provenance](../data/sdk/core-0.3.9.json) and
[the attributed extraction](../vendor/primus-core-0.3.9/NOTICE.md).
[Page Core provenance](../data/sdk/page-core-0.2.1.json) remains separate.
A build fails if pinned sources change.

Each profile runs in an ephemeral, locally bundled Worker with
`connect-src 'none'`. The Core worker excludes the native SDK runtime,
AlgorithmUrls, node discovery, sockets and the Page Core package. No SDK client
is constructed. Inputs and expected values stay in tab/Worker memory; they are
not put in requests, URLs, storage, saved views or report exports. Clear, cancel
or navigation terminates the worker and prevents stale results from appearing.

Both profiles support the narrowly validated single-signature wire format:
`reponseResolve`, string request header/body, one attestor entry and one
65-byte signature. Multiple signatures, unsigned input, unknown fields and
other SDK formats remain unsupported.

Results distinguish format, signature recovery, the selected SDK's signer pin,
application expectations and age. A signer match is not a universal verified
proof, live trust-registry/revocation check, eligibility decision or replay
protection. These SDK methods do not authenticate attestor-list metadata.
Their packed string encoding does not establish unambiguous field boundaries.
Expected-value comparisons concern the supplied input; integrating applications
must still enforce their own authorization, context and replay policy. No full
zk-proof computation or source-response revalidation runs here.

## Genuine positive reference

Primus publishes an exact signed reference for its Base claim diagnostic in
[ClaimBySourceAttestation.sol](https://github.com/primus-labs/tip-contracts/blob/5945b4e45339fc3785a731d996b9b6273b2bff5b/test/fixtures/ClaimBySourceAttestation.sol).
The integration pins that commit and source SHA-256. It verifies with Core
0.3.9 and is correctly rejected by the unchanged legacy Page Core pin.
Tampered data/context and mismatched application expectations are also tested.
This closes the positive-reference gate for Core; no genuine positive result
is claimed for the legacy Page Core profile.

```sh
npm run test:sdk-positive
```

This fetches only the deliberately published reference, validates its hash and
prepares a local ignored input. The raw reference is not bundled in the app,
committed to the repository or printed in reports. Browser positive checks have
traces/screenshots disabled and verify that input is absent from network traffic
and sanitized exports. The reference contains public account/claim context;
it is not used as a default example shown to users. The built-in rejection
example remains explicitly self-signed with a public test key.

## Developer Studio

Open `/developers/apps`, supply a name and allowed HTTPS origin (localhost is
allowed), and consent to the displayed metadata. Create a project and keep its
one-time ingest key. An opaque HttpOnly/SameSite=Strict owner cookie authorizes
management; HTTPS uses Secure. There is no account or cross-device recovery.
Losing that cookie loses management access.

New projects and reports use private Blob. They do not read, copy or modify
Neon history. Under `/developers/verify`, opt in, select your project and run a
check. Only sanitized metadata is recorded. Mark examples/tests explicitly;
they are excluded from default summaries. Developer Studio shows reported
outcomes, SDK versions and measured execution durations. Median/p90 need five
eligible calls and describe device execution, not Network latency or uptime.
Client reports remain untrusted and are separate from public chain analytics.

A browser workspace has up to three projects and expires within seven days of
its first project. Later projects share that expiry; each project's exact UTC
expiry is shown. Each project holds at most 1,000 events; batches have at most
25 events and 32 KiB. Registration has a persistent ten-attempt daily limit per
keyed requester bucket. The raw requester IP is never stored.

Rotate revokes the previous ingest key. Clear deletes project events. Delete
removes the project, key hash and events. Exports include app-owned metadata,
never keys, cookies, proof input or expectations. A key can submit only to its
project; it cannot read or administer it. CORS does not make embedded client
keys secret or reports authoritative.

### Event contract and integration

Exactly ten fields are accepted: `eventId`, `sdk`, `version`, `operation`,
`durationMs`, `outcome`, `sdkInvoked`, `isTest`, `errorCode`, `runtime`.
Package/version must be a supported pair: Core/0.3.9 or Page Core/0.2.1.
Operation/runtime and outcome/error enums are bounded; server receipt time is
added separately. Extra/nested fields, proof contents, wallet/recipient
identifiers, signatures, source URLs/responses, cookies, headers, raw exceptions
and client timestamps are rejected. Project name/origin are separate,
explicitly consented configuration metadata.

[The measured wrapper](../examples/primus-verifier-diagnostics.ts) invokes the
real selected verifier, times it and optionally reports that fixed projection.
Reporting is off by default and requires consent, an app ID and ingest key.
Use `profile: 'core'` with the attributed verification extraction, or `'page'`
with the pinned Page Core SDK. Copy the relative extraction files as well when
using Core. Telemetry failure does not change the local verifier result.

| Method | Path under `/api/v1/developer` | Authorization |
| --- | --- | --- |
| GET / POST | `/apps` | Owner cookie for reads; same-origin consent for creation |
| GET / DELETE | `/apps/:appId` | Owner cookie; same-origin deletion |
| POST | `/apps/:appId/rotate` | Owner cookie + same origin |
| POST | `/apps/:appId/record` | Owner cookie + same origin; local-inspector metadata |
| POST / OPTIONS | `/apps/:appId/events` | Scoped ingest key; registered-origin CORS |
| DELETE | `/apps/:appId/events` | Owner cookie + same origin |

Same event ID and metadata are idempotent. Conflicting reuse is rejected
atomically. App IDs do not authorize reads or writes. All responses are
`private, no-store`; unauthorized projects disclose no records.

## Storage, expiry and configuration

Production selects Blob through the existing
`PRIMUSSCOPE_PUBLICATION_STORE=blob`. No extra account or environment entry is
required. Server-only `BLOB_READ_WRITE_TOKEN` and
`DIAGNOSTICS_RATE_LIMIT_SECRET` already exist. Neon remains history-only under
`PRIMUSSCOPE_NEON_HISTORY_ONLY=1`; if Blob mode is absent, that flag blocks
metadata mutations instead of falling back to Neon writes. The PostgreSQL
adapter remains for isolated tests and legacy deployments, not production
history mutation.

Blob metadata uses a private prefix separate from the public publication.
UUIDv8 IDs carry an opaque owner namespace as a routing hint; authorization
checks the full owner hash or scoped ingest-key hash. Each bounded workspace is
compressed, strictly validated and replaced with an origin ETag conditional
write. Concurrent changes are retried finitely; failed writes preserve the last
stored state. Ingest keys are stored only as hashes.

Expired workspaces are immediately hidden/refused by the API. Native Blob TTL
also schedules physical deletion; its whole-day rounding and provider lifecycle
processing can lag logical expiry. No exact physical deletion time is promised.
Clear/Delete remove the relevant records from the current private object.
No raw attestation is ever stored. Existing Neon diagnostic records are not
imported into these new workspaces.

Blob usage follows the existing Vercel account plan/credits and provider limits.
This adds no paid external proof/data API, but is not unlimited free hosting.
Storage failure leaves local inspection usable and reports diagnostics as
unavailable rather than inventing a successful delivery.

## Validation

The mandatory CI positive gate exercises the pinned genuine Core reference,
legacy rejection, tampering, policy/format failures and sanitized reporting.
Unit checks cover source pins, actual verifier rejection, strict metadata,
SQL/API permissions and the Blob lifecycle, CAS conflicts, owner isolation,
quotas, expiry, deduplication, rotation and deletion. Browser checks cover both
profiles, Worker CSP, privacy, clear/navigation, accessibility and phone reflow.

Live API checks create temporary projects and verify authorization, CORS, key
revocation and deletion. A browser workflow creates a temporary project, records
a real local Core reference check with test labeling, reviews the version row,
clears events and deletes the project. Keys, cookies and proof input are excluded
from traces, screenshots and reports. HTTPS results are recorded separately
from local checks; SDK use implies no Primus endorsement or certification.
