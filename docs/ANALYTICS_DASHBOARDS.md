# Analytics dashboards

The Finance dashboard keeps Primus routes as the primary product view and presents public Unitas strategy metrics separately. The Network dashboard measures observed task and report activity. Both use UTC timestamps, expose their source coverage, and distinguish missing history from zero activity.

## Date selection, sharing and coverage

`retainedHistoryId` identifies the parsed bundled financial dataset alongside
the live publication’s `snapshotId`, so a chart can be traced to both inputs.

Both dashboards accept preset periods or **Custom UTC dates**, with inclusive
calendar-day bounds and a maximum of 366 days. The URL and saved dashboard view
preserve the dates, bucket interval, route and Network activity filters. Route
navigation keeps the analytical selection. Invalid, repeated or incomplete date
parameters produce a visible correction path and API 400, rather than silently
substituting another period.

Analytics and Network filter controls become available after hydration, avoiding
loss of an early selection when React applies server defaults. These controls
require JavaScript; a noscript message explains that requirement.

Coverage is stated separately for stock/NAV samples, public vault flows and
Primus operations. API `requestedFrom`/`requestedTo` describe the selection;
`coveredFrom`/`coveredTo`, `hasCoverage` and `historyComplete` describe its
intersection with available history. A wholly uncovered selection has no chart
points and displays unavailable KPIs, not measured zero activity. Daily/hourly
boundary buckets expose exact covered times and a `partial` flag in API data,
chart tables and bar-chart CSV. Stock-history completeness does not imply flow
completeness. Network completeness also requires complete registered-contract
source coverage.

For example: `/api/v1/finance/analytics?range=custom&from=2026-10-01&to=2026-10-15&interval=day`.
Financial KPIs use the last measured sample in the chosen window; 7D/30D APY may
use an earlier source anchor outside that window. A historical selection does
not display today's stock balances as if they were historical.

## Finance

The route selector covers **U/eU** and **USDT/eUSDT**, with a combined view available. Route activity counts public aggregator dispatch, finalization, cancellation and step events. Dispatch-to-finalization latency uses observed paired batch events; finalization does not imply that every participant claimed. These route-operation events do not expose deposit or withdrawal amounts.

Both routes reference the same underlying Unitas strategy. Its public **USDu assets, sUSDu share supply and USDu-per-sUSDu exchange price** are shown once as shared strategy data. Both tokens use 18 decimals. `totalAssets` excludes unvested rewards. These values are not route-specific TVL, a sum of eU/eUSDT balances, Primus-attributable TVL, or a user's private position.

The APY series derives from changes in the on-chain exchange price, rather than the dApp's separately published `avg_apy` field:

```text
100 × ((NAV_now / NAV_anchor) ^ (365 × 86,400 / actual_elapsed_seconds) − 1)
```

The anchor is the nearest prior sample to the 7-day or 30-day target. If it is more than two hours from that target, or the input rate is invalid, that APY point remains unavailable. This is a geometric annualization of historical shared strategy NAV, not a forecast or private user return.

The retained stock series has **61 daily samples across 60 days**, from
11 September through 10 November 2026. It includes assets, share supply,
exchange price and unvested amount, each tied to a BSC block hash and timestamp.
The public flow history now spans that entire retained period, with **4,098
Deposit/Withdraw events** whose exact contents and block metadata are checked
against their transaction receipts. Every one of the 60 daily net-share changes
reconciles exactly with the block-pinned `totalSupply()` samples.

Historical logs come from the keyless Pocket BSC endpoint; missing receipts
are recovered through the existing keyless Blast endpoint. The gateway returned
different partial event sets for different query forms. We combined topic and
address reads by transaction/log identity, rejected conflicts, and used historical
ABI supply reads to locate the last two omitted withdrawals. The adjacent
[provenance artifact](../data/strategy/unitas-history-provenance.json) records the
actual checks, receipt sources and query limitations. See the reproducible
[history workflow](STRATEGY_HISTORY.md).

The original recent-only flow artifact is superseded. Missing periods are never
filled with fake zeros; an empty bucket represents no matching event observed
within its verified interval. Raw asset/share amounts and transaction/log
identity are retained; sender, owner and receiver fields are excluded. These
are shared Unitas flows, not Primus-attributable deposits or withdrawals.

## zkTLS Network

The Network dashboard reports `SubmitTask`, `ReportResult`, `WithdrawBalance` and `CallbackFailed` activity, plus request/report cohorts and first-report latency. The retained bounded sample contains 116 requests, 90 report events and 17 withdrawals between 09 November 2026 06:45 and 07:18 UTC; these counts are not global Primus usage. Untimed events are excluded from time series and latency calculations. The current sample has no untimed events.

The report-observed rate is the share of unique tasks submitted within the selected period that have at least one later `ReportResult` observed by the end of that period. It is an observation-coverage measure, not a success rate: a request without an observed report is not an established failure, and reports arriving after the selected period are not counted. Reports are per-attestor events; they do not establish native task success or cryptographic proof verification. First-report latency includes only matched requests and their first later report.

## Sources, coverage and rollout

The strategy source is BNB Smart Chain (chain 56). Stock reads use the keyless public Blast endpoint `https://bsc-mainnet.public.blastapi.io`; historical flow events use `https://bsc.api.pocket.network`; scheduled forward
collection uses `https://bsc-rpc.publicnode.com` and block-pinned accounting
checks. Receipt validation can use the fixed keyless Blast endpoint. At the retained finalized pin, the proxy `0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae` resolved through its EIP-1967 slot to implementation `0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8`. The sUSDu vault is `0x385c279445581a186a4182a5503094ebb652ec71`, and its USDu asset is `0xea953ea6634d55dac6697c436b1e81a679db5882`. The collector checks runtime code hashes for the proxy, implementation, vault and asset against the retained pins in [strategy provenance](../data/strategy/unitas-history-provenance.json). The sanitized source dataset is [unitas-history.json](../data/strategy/unitas-history.json).

The current Finance route-operations sample covers four aggregators and nine public events from 09 November 2026 01:20 to 07:35 UTC. Its event times are present; other windows may contain untimed events, which are excluded rather than assigned an artificial time. The dashboard's selected-period coverage note indicates when earlier requested history is unavailable.

The optional collector strategy integration uses a two-phase schema rollout: deploy the web/API schema first, then set `PRIMUSSCOPE_STRATEGY_ENABLED=1` on the production collector and redeploy it. This keeps older strict web readers from seeing strategy fields they do not understand. Removing the flag stops new strategy reads and retains the last validated public history. Flow collection advances in bounded contiguous ranges; a failed range preserves prior coverage rather than filling missing periods with zeros. See [hosted indexer operations](HOSTED_INDEXER.md).

All retained strategy flows are shared-pool events, not Primus-specific capital flows. Public batch and strategy data never include wallet-linked confidential positions, decryption material, or per-user balances.

Forward collection combines independently filtered log reads and requires the
net minted/burned shares to match block-pinned share-supply changes before
advancing flow coverage. A successful RPC response alone does not establish
complete event retrieval. Unexplained supply changes preserve the previous
verified flow range rather than publishing a misleading zero.

## Comparing periods

Period shortcuts and the dashboard form use client navigation. An indeterminate
loading bar appears while the request is pending, with the earlier dashboard
retained until the new one is ready. Active shortcuts are highlighted; modified
clicks keep normal browser behavior. A delayed-response browser test verifies
this on desktop and mobile. `Last 30 days` compares with `Prior 30 days`, anchored
to the displayed source cutoff. Custom UTC dates use the immediately preceding
period of equal duration. All available history has no preceding equivalent.

Shared strategy comparisons include deposits, withdrawals and signed net flow
(inflow, outflow or balanced), plus total assets, shares, NAV per share and
7D/30D APY. Stock comparisons use the latest verified observation inside each
period, at most 36 hours before its end. Each actual measurement time is shown;
these are endpoint observations, not a claim of continuous sampling. APY uses
its own historical NAV anchor for each endpoint; missing anchors remain
unavailable. APY differences are percentage points. CSV includes exact values,
measurement timestamps, comparison basis and change units; NAV displays six
decimals.

## Restoring earlier Primus route activity

The 17 November Blob recovery restarted route-event coverage at a verified
finalized head. That date is not a contract deployment date. Retained research
already contained earlier route activity. Separate public archive reads now
verify the four registered aggregator proxies' first-code boundaries (U routes:
24 August; USDT routes: 20 September 2026), their runtime and implementation
pins, and their parent-block code absence.

Historical recovery scans contiguous BSC log windows, recognizes only registered
batch events, checks event headers and full transaction receipts, and fences the
join with existing coverage. A constructor `Upgraded` event is accepted only at
the independently checked first-code boundary with the pinned implementation;
other upgrades stop the recovery. The reducer rejects gaps or disagreement in
any overlapping event and preserves current IDs, source IDs, head checkpoints,
Network observations, strategy samples and flows. Only the earlier Finance
coverage boundary is extended. New archive events retain their registered RPC
source; no Neon history is read or exported by this process.

The Finance shared strategy comparison is presented as one compact panel with
one period selector, date legend and export. Eight visual rows are grouped into
Capital flows, Pool value and Yield. Mobile rows keep both period values and
their change together. The single CSV includes a `metric_group` column while
preserving each group's coverage, comparison basis and measurement timestamps.

## Maintaining APY chart and comparison lookbacks

The hourly collector maintains NAV lookbacks for both the current observation
and the actual previous endpoint of the 24h, 7d and 30d presets, then repairs
missing lookbacks for historical chart observations, newest first. A previous
endpoint is selected at or before the inclusive comparison boundary; its APYs
use that observation's own 7D/30D lookbacks. The existing two-hour eligibility
limit and actual-elapsed-time formula are unchanged. New archive searches aim
within fifteen minutes of the target to reduce drift as the window advances.

After collecting live stock and flows, a separate bounded archive phase accepts
at most four verified historical samples per invocation, with independent
72-stock-request and 80-header-request budgets and 60-second deadlines. Every
sample retains bytecode, implementation, accounting and cross-provider block
checks. Accepted samples survive later archive failures; pending lookbacks are
reported as `APY_ANCHORS_PENDING` without failing or starving live flow
collection. The next scheduled invocation retries the missing lookbacks.

Validated lookbacks live in `strategy.apyAnchors`, separate from stock
`samples`. Repairing a denominator neither adds a chart point nor replaces
the latest stock observation, and does not create another backfill obligation.
The chart and period comparisons use the same anchor pool and eligibility
rules. Lookbacks can be shared by nearby observations within the two-hour
tolerance. Targets before searchable history remain unavailable.

The APY chart spans the dashboard width, with padded, rounded percentage ticks,
latest 7D/30D values, series toggles and measured-point counts. Null APYs and
observation gaps remain breaks; isolated valid points have visible markers.
Hover, touch and keyboard observation controls expose exact timestamps and
values, with the unchanged raw table and CSV available below. Initial dates
without enough prior NAV history are explicitly counted as unmeasured rather
than assigned zero or interpolated.
