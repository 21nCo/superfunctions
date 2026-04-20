# Architecture Sketch
- `datafn/client/src/client.ts`
  - Extend config validation and runtime initialization for `sync.owner = "native"`.
- `datafn/client/src/query.ts`
  - Preserve ready/hydrating/remote-only routing when the remote adapter is native-backed.
- `datafn/client/src/mutate.ts`
  - Preserve local-first mutation semantics while delegating `schedulePush()` to native.
- `datafn/client/src/sync.ts`
  - Introduce native sync-controller delegation while keeping existing browser-owned sync behavior.
- `datafn/swift-bridge/src/*`
  - Implement the `WKWebView` bridge bus, protocol types, storage adapter, remote adapter, and sync controller.
- `datafn/swift/Sources/DatafnAppleRuntime/*`
  - Native runtime composition, schema loading, configuration, health, and backend selection.
- `datafn/swift/Sources/DatafnCoreDataStore/*`
  - Runtime Core Data model generation and `DatafnStorageAdapter` parity.
- `datafn/swift/Sources/DatafnWebViewBridgeHost/*`
  - Native bridge host that services WebView requests and emits events.
- `datafn/swift/Sources/DatafnServerSync/*`
  - Native DataFn-server sync ownership, auth parity, and same-store coordination.
- `datafn/swift/Sources/DatafnCloudKitSync/*`
  - CloudKit private-database backend for personal multi-device apps.
- `datafn/swift/Sources/DatafnSwiftUI/*`
  - Observation bindings over the shared native runtime/store.
- `datafn/examples/apple-webview-host/*`
  - End-to-end reference host app proving browser-vs-embedded dual-mode behavior.

# Dependency Graph
1. Define the TypeScript-native bridge interfaces and error codes before adapter implementations.
2. Implement the TypeScript bridge package before wiring `@datafn/client` to native-backed mode.
3. Update `@datafn/client` routing and sync ownership only after the bridge adapter contracts exist.
4. Build the Swift runtime/configuration and Core Data model generation before bridge host methods.
5. Build the bridge host on top of the Core Data store before native sync backends.
6. Implement DataFn-server sync before CloudKit so the shared runtime/storage abstractions are proven first.
7. Implement CloudKit mode after same-store exclusivity rules are in place.
8. Add SwiftUI bindings after the runtime/store/bridge layers are stable.
9. Finish with example hosts, docs, and end-to-end verification across browser, embedded server-sync, and embedded CloudKit modes.

# Phases Overview
- Phase 00 -> Goal: define shared config, protocol, and error surfaces. Delivered capability: repository-level contracts for native-backed mode. Verification: TS typecheck and protocol tests.
- Phase 01 -> Goal: implement `@datafn/swift-bridge`. Delivered capability: official `WKWebView` bridge bus plus native-backed storage/remote/sync adapters. Verification: bridge adapter tests.
- Phase 02 -> Goal: integrate native-backed mode into `@datafn/client`. Delivered capability: same public client API works in browser-owned and native-backed modes. Verification: client tests for both topologies.
- Phase 03 -> Goal: scaffold the Swift runtime and runtime Core Data model builder. Delivered capability: namespace-aware native runtime initialization. Verification: Swift unit tests for schema/model generation.
- Phase 04 -> Goal: implement the Swift Core Data store and WebView bridge host. Delivered capability: full storage parity and bridge request handling. Verification: Swift storage and bridge-host tests.
- Phase 05 -> Goal: implement native DataFn-server sync ownership and auth parity. Delivered capability: embedded apps use Swift-owned server sync over the same store. Verification: Swift sync tests plus TS embedded-mode integration tests.
- Phase 06 -> Goal: implement native CloudKit mode and exclusivity enforcement. Delivered capability: personal multi-device sync with no DataFn server. Verification: Swift CloudKit-mode tests and configuration guards.
- Phase 07 -> Goal: add SwiftUI bindings and shared-store observer behavior. Delivered capability: native SwiftUI and embedded WebView stay in sync through one store. Verification: observer tests.
- Phase 08 -> Goal: add example hosts, docs, and full end-to-end verification. Delivered capability: executable dual-mode reference implementation. Verification: npm tests, swift tests, and simulator-host integration tests.

# Definition Of Done
No phase is complete unless its verification steps pass.

# Recommended File Map By Workstream
- TypeScript client integration:
  - `datafn/client/src/client.ts`
  - `datafn/client/src/query.ts`
  - `datafn/client/src/mutate.ts`
  - `datafn/client/src/sync.ts`
  - `datafn/client/src/index.ts`
  - `datafn/client/__tests__/native-backed-mode.test.ts`
- TypeScript bridge package:
  - `datafn/swift-bridge/package.json`
  - `datafn/swift-bridge/tsconfig.json`
  - `datafn/swift-bridge/vitest.config.ts`
  - `datafn/swift-bridge/src/protocol.ts`
  - `datafn/swift-bridge/src/wkwebviewBus.ts`
  - `datafn/swift-bridge/src/nativeStorage.ts`
  - `datafn/swift-bridge/src/nativeRemote.ts`
  - `datafn/swift-bridge/src/nativeSyncController.ts`
  - `datafn/swift-bridge/src/index.ts`
  - `datafn/swift-bridge/__tests__/*.test.ts`
- Swift runtime:
  - `datafn/swift/Package.swift`
  - `datafn/swift/Sources/DatafnAppleRuntime/*.swift`
  - `datafn/swift/Sources/DatafnCoreDataStore/*.swift`
  - `datafn/swift/Sources/DatafnWebViewBridgeHost/*.swift`
  - `datafn/swift/Sources/DatafnServerSync/*.swift`
  - `datafn/swift/Sources/DatafnCloudKitSync/*.swift`
  - `datafn/swift/Sources/DatafnSwiftUI/*.swift`
  - `datafn/swift/Tests/**/*.swift`
- Example host and docs:
  - `datafn/examples/apple-webview-host/*`
  - `datafn/client/README.md`
  - `datafn/docs/content/docs/documentation/client/setup.mdx`
  - `datafn/docs/content/docs/documentation/sync/overview.mdx`
  - `datafn/docs/content/docs/reference/client/config.mdx`
  - `datafn/docs/content/docs/reference/client/storage.mdx`
  - `datafn/docs/content/docs/reference/client/transport.mdx`

# Execution Notes
- The Swift package SHOULD keep the runtime, persistence, bridge host, sync backends, and SwiftUI bindings in separate targets to reduce coupling.
- The TypeScript bridge package SHOULD remain optional for non-Apple consumers.
- The example host SHOULD prove the exact user story: one web app running in browser-owned mode and in embedded native-backed mode.
- CloudKit mode SHOULD be implemented against the same namespace-aware Core Data abstractions used by DataFn-server mode, not by a parallel storage stack.
