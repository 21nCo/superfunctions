# Phase goal

Create the Swift and bridge-package scaffolds, core configuration/envelope/error/protocol primitives, and repo hygiene updates so both packages build/test from repo root.

# In scope / Out of scope

- **In scope**: SwiftPM package creation, bridge-package creation, base configuration types, envelope decoding, error taxonomy, JSON value model, bridge protocol constants/envelopes, `.gitignore` updates, baseline README skeletons, and initial unit tests.
- **Out of scope**: concrete FileFn route methods, upload orchestration, background recovery, SwiftUI helpers, and contract artifact generation.

# Deliverables

- `.gitignore`
- `package.json`
- `filefn/swift/Package.swift`
- `filefn/swift/README.md`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnWKWebViewBridgeHost.swift`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnBridgeProtocol.swift`
- `filefn/swift/Sources/FileFnClient/FileFnClient.swift`
- `filefn/swift/Sources/FileFnClient/FileFnClientConfiguration.swift`
- `filefn/swift/Sources/FileFnClient/FileFnAuthProvider.swift`
- `filefn/swift/Sources/FileFnClient/FileFnEnvelope.swift`
- `filefn/swift/Sources/FileFnClient/FileFnError.swift`
- `filefn/swift/Sources/FileFnClient/FileFnJSONValue.swift`
- `filefn/swift/Sources/FileFnClient/FileFnLogger.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnEnvelopeTests.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnConfigurationTests.swift`
- `filefn/swift/Tests/FileFnWebViewBridgeHostTests/FileFnBridgeProtocolTests.swift`
- `filefn/swift-bridge/package.json`
- `filefn/swift-bridge/README.md`
- `filefn/swift-bridge/src/index.ts`
- `filefn/swift-bridge/src/protocol.ts`
- `filefn/swift-bridge/src/wkwebviewBus.ts`
- `filefn/swift-bridge/__tests__/protocol.test.ts`

# Requirements covered

- PKG-001
- CFG-001
- ENV-001
- ERR-001
- BRIDGE-001

# Implementation tasks

1. Create `filefn/swift/Package.swift` with `FileFnClient`, `FileFnSwiftUI`, `FileFnWebViewBridgeHost`, and test targets.
2. Add Swift build-artifact ignores to `.gitignore`.
3. Create `filefn/swift-bridge/package.json`, `tsconfig`/test scaffolding as needed, and a README skeleton for the bridge package.
4. Add repo-root helper script entries or documented equivalents in `package.json`.
5. Implement `FileFnClientConfiguration`, `FileFnAuthProvider`, `FileFnRetryPolicy`, `FileFnLogger`, and JSON coder defaults.
6. Implement `FileFnJSONValue`.
7. Implement `FileFnEnvelope`, `FileFnServerErrorPayload`, `FileFnCapability`, and `FileFnClientError`.
8. Define bridge protocol constants/envelopes and a minimal `FileFnWKWebViewBridgeHost`/bridge-bus skeleton that compiles but does not yet dispatch real FileFn methods.
9. Add a minimal `FileFnClient` initializer that validates configuration but does not yet ship endpoint methods.
10. Add unit tests for base-URL normalization, request-ID injection inputs, envelope decoding, missing-warnings normalization, bridge protocol constants/envelopes, and invalid-response handling.
11. Add README skeletons describing installation, package products, native-backed mode, and the fact that later phases fill in route/bridge coverage.

# Verification steps

- `swift build --package-path filefn/swift`
  - Expected outcome: the Swift package compiles successfully.
- `swift test --package-path filefn/swift --filter FileFnEnvelopeTests`
  - Expected outcome: envelope decoding and invalid-response tests pass.
- `swift test --package-path filefn/swift --filter FileFnConfigurationTests`
  - Expected outcome: configuration validation and base-URL normalization tests pass.
- `swift test --package-path filefn/swift --filter FileFnBridgeProtocolTests`
  - Expected outcome: bridge protocol envelope/constants tests pass.
- `npm --workspace filefn/swift-bridge test`
  - Expected outcome: the bridge package protocol/bus scaffold tests pass.

# Stop condition

Report the Swift/bridge scaffold paths, the list of created core primitives, and the exact commands that passed before starting Phase 01.
