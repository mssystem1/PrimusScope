# Base task discovery sources

These files document an official-source discovery seed. They do **not** establish
that the contract, ABI, proxy implementation, deployment height, event activity or
task semantics have been verified on Base.

- `base-task-source.json` records the chain, task contract, immutable upstream
  URLs and commit, file integrity hashes, event topics, view selectors and limits.
- `base-task-abi.json` contains six unmodified entries selected from the pinned
  upstream task ABI: four events and the `queryTask` / `taskTimeout` view reads.
  It contains schemas only; no task IDs, live event values or attestation payloads.

Upstream: `primus-labs/network-core-sdk` commit
`ec157e816d108a6fabdd42cb3a83375618c217e0`. The full ABI SHA-256 is
`08928fe658dcfeeb26c32a125deafd64d5edb4eb3e42bd0ae8bf824f52867382`.
The selected ABI SHA-256 is
`ae16dd8f4d7f3dd5ffed3b1c8208f6e1cf4ae44157edc6b3185b3f1440019ed8`.
Both hashes cover exact file bytes, including whitespace and trailing newline.

Event topics and view selectors use Ethereum **Keccak-256**, not Python
`hashlib.sha3_256`. They were generated with `ethereum-cryptography@3.2.0`, with
known empty-input and ERC-20 transfer-selector vectors checked. That package was
installed only in a temporary research directory; this fixture adds no project
dependency or SDK install step.

`queryTask` has a dynamic tuple output. The pinned ABI places `taskStatus` at
component index 7; use the ABI rather than the SDK TypeScript interface's field
order. Its schema includes sensitive-capable attestation fields because deleting
those components would corrupt the ABI. Never output or persist full task results
or request/header/body/data fields when performing discovery. Apply an explicit
safe-field allowlist to any decoded response.

One task can have multiple assigned attestors. `ReportResult` is per attestor and
has no task-success field. `CallbackFailed` does not establish proof failure.
Keep task identity `(chainId, taskContractAddress, taskId)` and task state separate
from cryptographic attestation validity.

`reviewStatus` remains `source_documented_runtime_unverified`; null deployment,
implementation and block-validity fields are intentionally unresolved. Validate
those fields through read-only discovery before promoting this source to an
approved production registry. No value-moving ABI functions, signing helpers or
transaction generation are included here.
