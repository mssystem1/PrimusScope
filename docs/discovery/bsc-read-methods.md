# BSC Finance: safe native-state read plan

Review date: 9 November 2026, Europe/Samara. Execution environment confirmed as the current `96d797f68b…` executor. This review used **four read-only Etherscan metadata requests and zero RPC requests**, preserving the parent probe's RPC budget. It made no configuration, publication, signing, decryption or user-specific calls.

The [read-only JSON fixture](../../scripts/discovery/sources/bsc-read-methods.json) contains exact ABI inputs/outputs, selectors, source hashes and native enums. It has no value-moving methods or live private values. Use it with the configured **proxy** addresses from the [BSC registry](../../scripts/discovery/sources/bsc-finance-source.json), not by calling the implementation's storage directly.

## Source/ABI evidence

The live Etherscan `getsourcecode` results matched the prior source observation hashes:

| Shared implementation | Explorer source | Canonical ABI SHA-256 | Raw source string SHA-256 |
| --- | --- | --- | --- |
| `UnitasMintAggregatorConfidential` | [0x8b6213044534be95c7d889594cedaaee7757c29d](https://bscscan.com/address/0x8b6213044534be95c7d889594cedaaee7757c29d#code) | `a0567f9b97132c77ec8938587cee8e3d5f5889220ca904c0b8a84f4a1f893169` | `e62d95a303aa2e4b39b9e28ec0c4265f5fc2f6d35f3d7affc689f225e5cf4073` |
| `UnitasRedeemAggregatorConfidential` | [0xa2652e6c1a825a18567fa670ff9b4416039aad46](https://bscscan.com/address/0xa2652e6c1a825a18567fa670ff9b4416039aad46#code) | `0787c7edbc281b4ae19e9aac6813ce64b476c95e96ecd19cfb092ecbf15da889` | `9f0559aa6cbabd4f2e738637d1f9d717b6cbcf54511be5c637077bc52d95805b` |

Each implementation has the same relevant public getter schema. Its ABI/source metadata does not independently prove current deployed-code identity or historical implementation ranges. The source files supporting the semantics below are `AggregatorConfidentialUpgradeable.sol`, `VaultAggregatorConfidentialUpgradeable.sol` and `UnitasAggregatorConfidentialUpgradeable.sol` under `contracts/finance/`.

## Minimal read surface

| Signature | Selector | Return | Safe interpretation |
| --- | --- | --- | --- |
| `currentAggregateId()` | `0x8c78144f` | `uint256` | Current open aggregate identifier; not a completed-batch count |
| `aggregateState(uint256 aggregateId)` | `0x70b90cc4` | `uint8` | Computed native state with an explicit nonexistence revert |
| `aggregateStep(uint256 aggregateId)` | `0x5fa17cdd` | `uint8` | Unitas operation step, not proof validity or a promised completion percentage |
| `aggregateCreatedAt(uint256 aggregateId)` | `0xbbe423ed` | `uint256` | Aggregate initialization timestamp, not first participant request time |
| `aggregateDispatchedAt(uint256 aggregateId)` | `0x42156afe` | `uint256` | Timestamp recorded during dispatch; zero needs state/existence context |
| `aggregateMinAggregateAge(uint256 aggregateId)` | `0x387e0876` | `uint256` | Per-aggregate pinned minimum-age configuration |
| `aggregateCallbackDeadline(uint256 aggregateId)` | `0x19cda6fb` | `uint256` | Per-aggregate callback configuration, not an observed completion timestamp |
| `minAggregateAge()` | `0x9ea67f06` | `uint256` | Current global configuration, which may differ from an older aggregate's pinned value |
| `paused()` | `0x5c975abb` | `bool` | This aggregator's pause flag only |
| `vault()` | `0xfbfa77cf` | `address` | Underlying vault reference; no user ownership or TVL attribution follows |

Function selectors use Ethereum Keccak-256, not Python/FIPS SHA3-256. No caller wallet address, permit, private selector or signing operation is required for these proposed reads. Actual RPC invocation remains the parent task's responsibility.

## Native state semantics that affect the UI

`aggregateState(id)` resolves in this order:

1. A canceled flag yields **Canceled**.
2. Otherwise nonzero exchange-rate state yields **Finalized**.
3. Otherwise nonzero unshield-request state yields **Dispatched**.
4. Otherwise an ID equal to `currentAggregateId()` yields **Open**.
5. Other IDs revert with **`AggregateNonexistent(id)`**.

The implementation's enum order is `0 Open`, `1 Dispatched`, `2 Finalized`, `3 Canceled`. These facts justify native state labels after runtime compatibility checks. They do not justify publishing the numeric exchange rate, inspecting user unshield histories, or treating batch finalization as individual claim completion.

The Unitas step order is `0 None`, `1 MintInit`, `2 MintAwaitOutput`, `3 RedeemInit`, `4 RedeemCooldown`, `5 RedeemAwaitOutput`. Do not collapse these into invented percentage progress, or label a callback/timeout observation a proof failure.

The aggregate counter initializes to **1**. Its helper returns the current ID and post-increments it; dispatch uses that helper and then initializes the new current aggregate. Initialization writes `block.timestamp` and snapshots the current slippage/minimum-age/callback configuration. An open batch may therefore exist before it has participants, and its age is not any user's waiting time. The counter is not the number of finalized batches.

Timestamp/step mappings can yield a zero default without proving existence. Read native state/existence first. Do not chart absent zero timestamps as Unix epoch or call `None` an observed valid aggregate. No dedicated finalization-time getter was established in this selected surface; exact finalization history should come from reconciled events and block timestamps.

## Bounded runtime validation plan

1. Confirm chain 56 and select one explicit block with its block hash. Treat the provider's `safe`/`finalized` support as observed capability until the BSC policy is reviewed; native **Finalized** batch state is a different concept from finalized chain data.
2. Read proxy code and the known EIP-1967 implementation slot at that block, then compare the reported implementation with the reviewed source/ABI identity. A source-code SHA-256 and a runtime-bytecode hash are different artifacts and cannot be compared directly as if they were equal.
3. Read `currentAggregateId()` on a selected aggregator proxy. Read state, step and selected timestamps at **the same pinned block**, using IDs already seen in the approved event sample and, if needed, the current ID. Do not enumerate arbitrary wallets or scan every possible ID.
4. Validate response encoding/ranges: states and steps fit their enums; timestamps are meaningful only after existence is established; booleans use canonical values. An unsupported/reverting read remains unavailable, not zero.
5. Compare dispatched/finalized/canceled event identity and native state at a later pinned block while respecting reorg/correction history. A later state can legitimately supersede a prior event. Do not require the current state to equal every historical event label.
6. Scope batches by **`(chainId, aggregatorProxy, aggregateId)`**. The two routes share implementation contracts and an underlying vault; the same numeric ID on different proxies is not the same batch.

Historical validation still needs deployment/upgrade boundaries and archive-read availability. An accepted recent range does not establish full history. Re-index overlapping bounded ranges, deduplicate canonical identities, reconcile receipts/block hashes and retain explicit gap/finality/source metadata before forming production aggregates.

## Privacy and publication boundary

Do not query or publish `totalDeposits`, exchange-rate values, participant mappings, balances, permits or private request history merely to derive public dashboards. The native state getter can supply a label without exposing those values. An unchanged pause flag or source heartbeat also cannot establish fund safety or insolvency.

This fixture enables public operational-state checks only. Monetary aggregates, APY, user return, precise owner wait time, confidential TVL and public private-wallet timelines remain outside this read plan and require separate source/privacy approval.
