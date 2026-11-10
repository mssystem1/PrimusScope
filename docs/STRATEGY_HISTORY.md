# Public vault flow history

The Finance asset/share/NAV series uses historical ABI calls to the shared
Unitas vault. Exact deposits and withdrawals require its ERC-4626 `Deposit` and
`Withdraw` logs: the verified StakedUSDuV2 ABI has no lifetime deposit/withdrawal
counter. Subtracting balances or TVL cannot recover both gross amounts.

The retained verified vault source is
[StakedUSDuV2](https://bscscan.com/address/0x385c279445581a186a4182a5503094ebb652ec71#code).
Cooldown entry calls the same `_withdraw` implementation and emits `Withdraw`;
this measures withdrawal from the staked vault, not eventual release from its
separate cooldown silo. Administrative share destruction can emit
`LockedAmountRedistributed` instead, so an unexplained supply discrepancy stops
this harvester rather than becoming invented deposit/withdrawal activity.

## Free backfill workflow

The keyless public Pocket BSC endpoint is listed in the
[DefiLlama chain registry](https://github.com/DefiLlama/chainlist/blob/main/constants/extraRpcs.js).
The harvester requests at most 5,000 blocks per log query, uses bounded batches
and retains progress in ignored `.local/research/pocket-history-checkpoint.json`.
No API token, paid fallback or managed cloud configuration publication is needed.
Public-provider rate limits still apply; retain the checkpoint and resume after
any reported source failure or cooldown instead of restarting the whole scan.

```sh
node --use-env-proxy --import tsx scripts/discovery/harvest-unitas-pocket-flows.ts
```

Only one process may own the checkpoint. A PID lock rejects overlapping runs;
interrupted runs leave resumable progress, and a later invocation reclaims a
lock only after its owning process has exited.

The inspected public gateways sometimes returned different partial log sets for
different filter forms. The recorded repair combines topic-filtered and
address-only reads by transaction/log identity, rejecting conflicting facts.
The recorded repair modes are `--repair-address-range --repair-from=BLOCK
--repair-to=BLOCK --repair-pass=1` (repeat with pass 2 for a second range), followed
by `--verify-union-receipts` and `--finalize-union`. The checked-in verified dataset
also acts as an explicit replay seed; unknown or conflicting new facts must pass
the same receipt and accounting gates. Missing optional local probe output does
not prevent a seeded replay.

Remaining nonzero share residuals can be localized with bounded historical ABI
reads instead of repeating entire block ranges:

```sh
node --use-env-proxy scripts/discovery/recover-unitas-share-gaps.mjs
```

This binary search reads `totalSupply()` at numeric block tags to locate a gap,
then decodes actual emitted events at the resulting block. It never turns a
balance difference into an invented deposit or withdrawal. Candidates are saved
in ignored research output and must still pass receipt validation before entering
the published dataset.

A completed scan must reconcile canonical event identity, block hashes and
timestamps, receipt contents, the retained overlap and all daily share-supply
changes before replacing `data/strategy/unitas-history.json`. The adjacent
provenance file records the actual verification counts and covered boundaries.
Only public transaction/log identity, asset/share amounts and timestamps are
retained. Sender, owner and receiver topics are excluded from saved data.

Source event coverage is an observation of that provider, not independent chain
consensus or a cryptographic receipt proof. The dataset describes the shared
Unitas pool; it is not the sum of Primus U/eU and USDT/eUSDT user positions.

## Publish validated history

Deploy web and collector schemas supporting the history source before publishing
new PostgreSQL data. Load the existing worker credential securely, then run:

```sh
node --use-env-proxy --import tsx scripts/publish-strategy-history.ts --dry-run
node --use-env-proxy --import tsx scripts/publish-strategy-history.ts
```

The script refuses partial stock-period flow coverage, a quarantined publication,
a different strategy, conflicting log facts or disjoint coverage. It acquires
the hosted collector lease, rereads current state and preserves newer live
samples and events while adding the historical interval. The publication uses
lease/revision fencing and keeps Finance and Network event checkpoints intact.
The public app reads the new publication without a rebuild. Later scheduled
jobs retain the full history and add only validated subsequent ranges.

The seeded stock interval defines this backfill's beginning; it is not a claim
to cover the contract's entire lifetime. See [analytics definitions](ANALYTICS_DASHBOARDS.md)
for UTC date selection, partial boundary buckets and APY methodology.
