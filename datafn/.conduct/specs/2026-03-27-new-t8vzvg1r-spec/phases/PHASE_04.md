# Phase Goal
Implement the Swift Core Data storage runtime and the `WKWebView` bridge host that serves storage, remote-routing, sync-control, and health requests.

# In Scope / Out Of Scope
- In scope:
  - Core Data store operations for full DataFn storage parity.
  - `WKScriptMessageHandler` host implementation.
  - Bridge event emission.
- Out of scope:
  - DataFn-server sync backend.
  - CloudKit backend.

# Deliverables
- `datafn/swift/Sources/DatafnCoreDataStore/DatafnCoreDataStore.swift`
- `datafn/swift/Sources/DatafnCoreDataStore/DatafnChangelogStore.swift`
- `datafn/swift/Sources/DatafnWebViewBridgeHost/DatafnWKWebViewBridgeHost.swift`
- `datafn/swift/Sources/DatafnWebViewBridgeHost/DatafnBridgeDispatcher.swift`
- `datafn/swift/Sources/DatafnWebViewBridgeHost/DatafnBridgeEventEmitter.swift`
- `datafn/swift/Tests/DatafnCoreDataStoreTests/StorageParityTests.swift`
- `datafn/swift/Tests/DatafnWebViewBridgeHostTests/BridgeHostTests.swift`

# Requirements Covered
- BRG-001
- STO-001
- STO-002
- SEC-001
- EVT-001
- OBS-001

# Implementation Tasks
- [ ] Implement record, join-row, kv, meta, changelog, lifecycle, and health methods over Core Data.
- [ ] Guarantee atomic `mergeRecord` and changelog dedupe semantics.
- [ ] Implement the bridge dispatcher with strict method whitelisting.
- [ ] Implement handshake validation and event emission.
- [ ] Surface health reports over `health.check`.
- [ ] Add tests for storage parity, event delivery, method rejection, and schema-hash mismatch.

# Verification Steps
- `swift test --package-path datafn/swift`
  - Expected: storage and bridge-host tests pass.

# Stop Condition
Report the complete bridge method table, storage parity test results, and a sample `health.check` response before starting Phase 05.
