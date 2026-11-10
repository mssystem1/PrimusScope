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
