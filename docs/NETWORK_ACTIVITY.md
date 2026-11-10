# Network activity research

The Network page now lets an anonymous visitor inspect every covered public
event through a paginated list. It supports exact inclusive block ranges, event
type and an optional exact task ID. No wallet, API key or new environment setting
is needed. The overview metrics and block chart retain their full published scope;
the calendar dashboard uses its own selected UTC period. Event filters affect
the activity list and its export. Shared/saved views preserve both selections.

Open **View chart data** and select a block interval to drill into its events.
Use **Apply filters** to combine a type, range and task. **Copy view link** copies
a shareable URL; **Save view** keeps that selection in this browser's Workspace.
Saved views reopen against the current publication, without a stale pagination
cursor. Titles distinguish event types, selected bounds and task identifiers.

Each row links to the original transaction. Task-related events also link to
the full contract-scoped task evidence. Withdrawals have no task ID in the
published event projection. Requests, per-attestor reports, withdrawals and
callback failures stay separate; none receives a proof-validity verdict.

## Public API

```text
GET /api/v1/network/events?eventKind=ReportResult&limit=25
```

| Filter | Meaning |
| --- | --- |
| `fromBlock`, `toBlock` | Optional inclusive decimal block bounds; defaults to the published range |
| `eventKind` | `SubmitTask`, `ReportResult`, `WithdrawBalance` or `CallbackFailed` |
| `taskId` | Exact 32-byte public task ID; case normalizes to lower case |
| `chainId`, `contractAddress` | Optional explicit registered scope; currently Base 8453 and the published task contract |
| `limit` | 1–100 events, default 25 |
| `cursor` | Continuation token from the previous response |

The response includes event rows, matching total, page positions, exact
selection, full source coverage, freshness and snapshot ID. Ordering is newest
block first, then descending log position with deterministic identity ordering.
Block comparisons use integers without JavaScript floating-point conversion.

Filters combine conjunctively. A valid empty selection returns zero matching
events within that scope. A range outside published coverage returns 422,
rather than implying that an unindexed interval had no activity. Malformed,
repeated or unsupported query fields return 400 without echoing their values.

Continuation binds the resource, normalized selection, page size and snapshot.
Changing filters or page size requires restarting pagination. A new publication
returns 409 `SNAPSHOT_EXPIRED`; the page offers **Restart matching events** with
the valid selection preserved. Public readers never initiate chain RPC requests.

## Export

**Export matching events** exports all selected events across pages, up to 5,000
rows. The link carries the current `snapshotId`; if new observations arrive
before download, the API returns 409 and the page offers **Refresh matching
events**, preserving the selected filters. A broad
selection over the cap asks the visitor to narrow it. Filtering occurs before
the cap is applied.

```text
GET /api/v1/exports/metrics.csv?domain=network&eventKind=ReportResult&fromBlock=…&toBlock=…&snapshotId=…
```

CSV and JSON use the same selection and event order. Existing event/source
identity and coverage columns remain. Additional columns describe event time
when sampled, selected block bounds, event-type filter and task-ID filter.
Missing event times remain empty. Unsupported amounts, participants, raw proof
payloads and confidential balances are not added. These Network filters do not
apply to Finance exports.

## Validation

Data/API tests cover combined filters, integer precision, ordering, complete page
traversal, cursor and snapshot boundaries, export identity/provenance, empty
results and cap behavior. Browser workflows exercise filtering, copy/share,
save/reopen, reset, exact CSV scope, pagination recovery and chart drill-down on
desktop and 360/390-pixel phones, including automated WCAG checks. See
[TESTING.md](TESTING.md) for commands and deployed-validation requirements.
