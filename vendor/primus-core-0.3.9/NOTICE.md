# Primus Core SDK verification extraction

Source: `@primuslabs/zktls-core-sdk@0.3.9`, pinned in
[data/sdk/core-0.3.9.json](../../data/sdk/core-0.3.9.json).
The encoding/environment files and verification method block are unchanged
upstream bytes. `verify.cjs` only connects those pieces without importing
the native runtime, creating a client or starting network discovery.
No attestation payload is included. This integration is not Primus endorsement.
