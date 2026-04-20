# Phase goal

Publish the machine-readable contract artifact, add integration and bridge-package coverage, and finalize documentation and repo-level verification hooks.

# In scope / Out of scope

- **In scope**: OpenAPI contract source/artifact/tests, local integration tests against the existing demo server, bridge-package verification wiring, final README content, and repo-level helper scripts/documentation.
- **Out of scope**: new runtime features beyond what prior phases already implemented.

# Deliverables

- `filefn/server/src/client-contract.ts`
- `filefn/server/contracts/filefn-client-v1.openapi.json`
- `filefn/server/tests/client-contract.test.ts`
- `filefn/swift/Tests/FileFnIntegrationTests/FileFnDemoServerIntegrationTests.swift`
- `filefn/swift/README.md`
- `filefn/swift-bridge/README.md`
- `package.json`

# Requirements covered

- CONTRACT-001
- TEST-001
- DOC-001

# Implementation tasks

1. Add a deterministic source-of-truth representation for the Swift-supported FileFn HTTP contract.
2. Emit or assemble `filefn/server/contracts/filefn-client-v1.openapi.json` from that source of truth.
3. Add TypeScript-side tests validating the artifact's route/header/envelope completeness.
4. Add Swift integration tests that run against the existing demo server under `filefn/examples/full-demo/server`.
5. Ensure repo-root verification docs/scripts cover `swift test`, `swift test --filter FileFnWebViewBridgeHostTests`, and `npm --workspace filefn/swift-bridge test`.
6. Expand `filefn/swift/README.md` to cover installation, configuration, reads, foreground upload, background recovery, SwiftUI helpers, native-backed WebView mode, optional capability routes, contract artifact location, and local verification commands.
7. Expand `filefn/swift-bridge/README.md` to cover the handshake, native-backed mode, asset-handle upload semantics, bridge events, and the explicit non-goal of bridging browser-owned raw bytes.

# Verification steps

- `npm test -- --run filefn/server/tests/client-contract.test.ts`
  - Expected outcome: contract artifact validation passes.
- `swift test --package-path filefn/swift`
  - Expected outcome: all Swift unit tests pass.
- `swift test --package-path filefn/swift --filter FileFnWebViewBridgeHostTests`
  - Expected outcome: bridge-host tests remain green as part of the final verification pass.
- `npm --workspace filefn/swift-bridge test`
  - Expected outcome: bridge package tests pass from repo root.
- `npm --prefix filefn/examples/full-demo/server run dev`
  - Expected outcome: demo server starts locally.
- `FILEFN_BASE_URL=http://127.0.0.1:3001/filefn swift test --package-path filefn/swift --filter FileFnIntegrationTests`
  - Expected outcome: integration tests against the live demo server pass.

# Stop condition

Report the final contract artifact path, both README sections added, the bridge-package verification command, and the unit/integration verification commands that passed. No additional phase may begin because this is the terminal delivery phase.
