# Analytics dashboards

The Finance dashboard keeps Primus routes as the primary product view and presents public Unitas strategy metrics separately. The Network dashboard measures observed task and report activity. Both use UTC timestamps, expose their source coverage, and distinguish missing history from zero activity.

## Finance

The route selector covers **U/eU** and **USDT/eUSDT**, with a combined view available. Route activity counts public aggregator dispatch, finalization, cancellation and step events. Dispatch-to-finalization latency uses observed paired batch events; finalization does not imply that every participant claimed. These route-operation events do not expose deposit or withdrawal amounts.

Both routes reference the same underlying Unitas strategy. Its public **USDu assets, sUSDu share supply and USDu-per-sUSDu exchange price** are shown once as shared strategy data. Both tokens use 18 decimals. `totalAssets` excludes unvested rewards. These values are not route-specific TVL, a sum of eU/eUSDT balances, Primus-attributable TVL, or a user's private position.

The APY series derives from changes in the on-chain exchange price, rather than the dApp's separately published `avg_apy` field:

```text
100 × ((NAV_now / NAV_anchor) ^ (365 × 86,400 / actual_elapsed_seconds) − 1)
```

The anchor is the nearest prior sample to the 7-day or 30-day target. If it is more than two hours from that target, or the input rate is invalid, that APY point remains unavailable. This is a geometric annualization of historical shared strategy NAV, not a forecast or private user return.

The retained stock series has **61 daily samples across 60 days**, from 11 September through 10 November 2026. It includes assets, share supply, exchange price and unvested amount, each tied to a BSC block hash and timestamp. The retained flow series has **67 receipt-verified public sUSDu events over seven days**: 31 deposits and 36 withdrawals. The flow scan covered 3–10 November 2026 and stores asset/share amounts with block, timestamp and transaction/log identity; it omits sender, owner and receiver fields. A 30-day flow query was denied at its oldest range by PublicNode (HTTP 403), so the charts show the verified seven-day window only. They do not draw zero-valued buckets beyond the covered interval. Within a complete scanned interval, an empty time bucket means no matching public vault event was observed there.

## zkTLS Network

The Network dashboard reports `SubmitTask`, `ReportResult`, `WithdrawBalance` and `CallbackFailed` activity, plus request/report cohorts and first-report latency. The retained bounded sample contains 116 requests, 90 report events and 17 withdrawals between 09 November 2026 06:45 and 07:18 UTC; these counts are not global Primus usage. Untimed events are excluded from time series and latency calculations. The current sample has no untimed events.

The report-observed rate is the share of unique tasks submitted within the selected period that have at least one later `ReportResult` observed by the end of that period. It is an observation-coverage measure, not a success rate: a request without an observed report is not an established failure, and reports arriving after the selected period are not counted. Reports are per-attestor events; they do not establish native task success or cryptographic proof verification. First-report latency includes only matched requests and their first later report.

## Sources, coverage and rollout

The strategy source is BNB Smart Chain (chain 56). Stock reads use the keyless public Blast endpoint `https://bsc-mainnet.public.blastapi.io`; flow events use `https://bsc-rpc.publicnode.com`. At the retained finalized pin, the proxy `0xe9e8573bb351da16c6ee7ddac0cbc70b7f9784ae` resolved through its EIP-1967 slot to implementation `0x8d5e94c1eaae7d71ed4fcba2402e6b03380354f8`. The sUSDu vault is `0x385c279445581a186a4182a5503094ebb652ec71`, and its USDu asset is `0xea953ea6634d55dac6697c436b1e81a679db5882`. The collector checks runtime code hashes for the proxy, implementation, vault and asset against the retained pins in [strategy provenance](../data/strategy/unitas-history-provenance.json). The sanitized source dataset is [unitas-history.json](../data/strategy/unitas-history.json).

The current Finance route-operations sample covers four aggregators and nine public events from 09 November 2026 01:20 to 07:35 UTC. Its event times are present; other windows may contain untimed events, which are excluded rather than assigned an artificial time. The dashboard's selected-period coverage note indicates when earlier requested history is unavailable.

The optional collector strategy integration uses a two-phase schema rollout: deploy the web/API schema first, then set `PRIMUSSCOPE_STRATEGY_ENABLED=1` on the production collector and redeploy it. This keeps older strict web readers from seeing strategy fields they do not understand. Removing the flag stops new strategy reads and retains the last validated public history. Flow collection advances in bounded contiguous ranges; a failed range preserves prior coverage rather than filling missing periods with zeros. See [hosted indexer operations](HOSTED_INDEXER.md).

All retained strategy flows are shared-pool events, not Primus-specific capital flows. Public batch and strategy data never include wallet-linked confidential positions, decryption material, or per-user balances.
