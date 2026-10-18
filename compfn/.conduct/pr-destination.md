# PR destination correction

This branch starts at sf-next/next b21477fc9 and applies the compfn implementation from 125f328c5. It replaces the misplaced origin draft #246; no changes from the broader origin/dev history are imported. Existing sf-next specifications and historical artifacts are preserved.

Prior package tests and packed/browser checks belong to the original implementation checkout. This new target has older shared packages and a different workspace graph: clean installation, lock reconciliation and target-context validation remain open before merge. Shared prerequisite publication or synchronization is required where package manifests request newer versions. This draft is not a completion claim.

## Shared prerequisite integration

Merged shared prerequisite head0ef7b9cb6 and aligned CompFn to DB0.4.0/HTTP0.3.1. Standard npm11 lock regeneration followed by scoped default npm10 clean installation passes (512packages). Core/CLI/admin and shared dependencies build. Core110/admin8 tests and typechecks pass, including native SQLite CLI persistence after rebuilding better-sqlite3.

Fresh isolated packed consumers pass strict Node16/NodeNext ESM and dynamic-CJS declaration checks and bundle/SSR/admin runtime checks on exact Node20.0.0,20.20.2,22.23.3. Production audit has zero vulnerabilities. Node18.18 fails admin global WebCrypto and remains outside the declared >=20 runtime. The harness supports NPM_CLI for npm11 local-tarball installation and explicitly tests the declared Node20.0 minimum.

Hosted checks, original full specification, browser/admin integration and remaining readiness requirements still need verification. This is not a release or complete readiness claim.
