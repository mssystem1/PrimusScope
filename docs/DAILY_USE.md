# Daily-use analytics and local review tracking

Finance and Network compare a selected fixed period with the immediately
preceding period of exactly equal duration. Both periods use the same snapshot,
registered contracts, event definitions and route filter. Bounds are inclusive
to the millisecond; the previous period ends one millisecond before the selected
period begins. Custom dates are whole UTC days. Rolling windows end at the
relevant source watermark, not an unsupported wall-clock head.

“All available” has no equivalent previous period. Each metric retains a value
only for a fully covered window. A difference requires both complete windows;
unknown coverage, incomplete scans and relevant untimed events suppress it.
Covered zero activity stays zero. Percentage change is unavailable when the
previous value is zero; signed net flows use the absolute previous magnitude.
Source bounds remain visible when a comparison cannot be calculated.

Network comparisons separate request, individual report, withdrawal and
callback-failure events. These are not protocol success or proof-validity rates.
Finance independently compares registered Primus route operations and shared
Unitas deposits, withdrawals and net flows. Strategy amounts and differences use
raw-unit BigInt arithmetic and exact decimal strings. They are not private
positions or Primus-attributable capital. Source windows can differ between
route operations and the shared strategy and are shown separately.

Comparisons appear in `/finance`, route dashboards and `/network`, and as an
additive `comparison` object on their existing analytics JSON endpoints.
Comparison CSV downloads include exact values, both requested bounds, coverage
flags, source scope and snapshot ID. Token values on screen are rounded to two
decimals using integer arithmetic; counts retain integer precision. Existing saved/share links preserve the
selected dates without a new query option.

## Saved objects

Save a public task, batch, vault route or view, then open Workspace. Overview also
shows updates when this browser has saved items. The first successful check
records a review baseline locally. Later checks compare with that baseline;
checking or revisiting never silently acknowledges changes. “Mark as reviewed”
replaces only the selected object's baseline. Remove/clear also prunes its
baseline. Existing `primusscope.public-workspace.v1` preferences remain compatible.

Tasks and batches track observed event-set fingerprints, event counts and
separately labelled native-state samples; vault routes track public operation
events. Advancing coverage alone is not an object-state change. A changed
coverage start, registry or serving mode requires review before a delta can be
shown. Regressed watermarks/samples are flagged as source revisions. A missing
object remains unavailable in the current scope, not “deleted.”

Saved views track source-coverage or shared-strategy observation updates. These
signals do not claim growth in a rolling/filter-specific metric. Open the saved
view to inspect its selected analytics. This avoids comparing changing rolling
periods or unrelated dashboard/activity scopes as if they were identical.

Checks run when the relevant page opens or when “Check saved objects” is pressed.
They do not provide background monitoring, push/email alerts or cross-device
sync. Failures preserve the last successful result and review baseline, with an
explicit error. Storage failure explains that a persistent baseline was not
saved. Source age, source block range and last-check time remain distinct.

## Public read API and storage

`POST /api/v1/workspace/check` accepts a strict `{items:[{id,href}]}` body, at
most 50 unique IDs and 48 KiB. Only supported local public routes are interpreted;
the server never fetches an arbitrary URL. It reads one stored publication and
returns minimal counts, state labels, source bounds and hashes. Invalid/unknown
views get an explicit unavailable result. Responses are `private, no-store`.
The server does not store a watchlist or review history and needs no new keys,
database tables, upstream API calls or environment settings.

Baselines use `primusscope.public-changes.v1`, at most 50 saved public objects.
They contain public identifiers, counts, sampled state labels, source bounds,
fingerprints and device review times. No raw event arrays, participants, wallet
balances, attestations, authorization material or SDK diagnostics are retained
there. Diagnostic project storage and its owner cookie remain separate.

Tests cover exact adjacent periods, boundaries, zero/missing history, route
isolation, amounts above JavaScript's safe integer range, strict request/input
limits, source revisions, unchanged objects under advancing coverage, legacy
preferences and cleanup. Browser checks reconcile CSV to JSON, preserve saved
dates, retain alerts until review, recover after failed reads and clear local
baselines. The indexed test also advances a real local publication without a
web rebuild and verifies stable object/scope fingerprints.
