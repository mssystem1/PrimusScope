# Separate zkTLS Network: live documentation review

Historical source checks: 8 November 2026, approximately 16:18 UTC. Consolidated after environment migration on 9 November in Europe/Samara. No additional Base calls are required for the current BSC Finance priority.

Official pages were retrieved with HTTP 200 by the parallel source reviewer:

| URL | SHA-256 of HTML |
| --- | --- |
| https://docs.primuslabs.xyz/primus-network/understand-primus-network/ | `e59fa3f0991fba73e9fb9b84eab36937c2acf95ac100f272f937ecaada105caf` |
| https://docs.primuslabs.xyz/primus-network/attestor-node-guides/ | `8e9dc1b4383ecf184115f0c229bba5a7b070562f47bfb9d519e4ca7ed69603d5` |
| https://docs.primuslabs.xyz/build/overview/ | `e7effc15fcda753680c5e0f363b9344c220852261cb5f14057ac183a891f4c69` |
| https://docs.primuslabs.xyz/enterprise/page-sdk/overview/ | `298336c6e3b738d0f7927a5e81ec102849001e2fb77d51be24dbbdec8ea27db8` |
| https://docs.primuslabs.xyz/enterprise/page-sdk/install/ | `c028b89abb2dedc79547a5779877b004df5c2afbcf3f10a631ab41c4dd9c7696` |

The attestor guide corroborates the separately documented Base task and node addresses. It does not establish deployment blocks, historical event completeness or a real lifecycle fixture. Those addresses are not BSC Confidential Finance addresses.

Network-JS uses the browser extension; Network-Core is a backend path. Enterprise and Lightweight Page SDK modes have separate coverage/trust assumptions. The Lightweight SDK is concretely documented as `@primuslabs/zktls-page-core-sdk`, exporting `PrimusPageCoreTLS`. It requires WASM/worker assets, SharedArrayBuffer and COOP `same-origin` / COEP `require-corp`; any later tool must isolate and test those requirements against wallet/resource behavior.

Attestation results can be plaintext and `additionParams` can contain user/session information. Examples that print full results are not appropriate for PrimusScope's telemetry or reports. SDK proof-generation free credits are unrelated to a free chain-data API quota.

Supported chains differ between browser guides, attestor guides and backend source constants. Product coverage must be mode/contract/version-specific. No universal ecosystem proof count is justified. Keep this integration separate from the selected BSC Finance/Etherscan data path.
