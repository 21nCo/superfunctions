# Phase Goal
Implement native-backed DataFn-server synchronization, including auth parity and shared-store remote routing.

# In Scope / Out Of Scope
- In scope:
  - Swift-owned DataFn HTTP/WebSocket transport.
  - Shared changelog/cursor sync loop against the Core Data store.
  - Auth parity for native-owned server access.
  - Bridge-backed remote routing for remote-only resources and hydration fallback.
- Out of scope:
  - CloudKit backend.
  - SwiftUI bindings.

# Deliverables
- `datafn/swift/Sources/DatafnServerSync/DatafnServerSyncEngine.swift`
- `datafn/swift/Sources/DatafnServerSync/DatafnServerRemoteExecutor.swift`
- `datafn/swift/Sources/DatafnAppleRuntime/DatafnAuthConfiguration.swift`
- `datafn/swift/Tests/DatafnServerSyncTests/DatafnServerSyncEngineTests.swift`
- `datafn/swift/Tests/DatafnServerSyncTests/AuthParityTests.swift`
- `datafn/client/__tests__/native-backed-server-sync.test.ts`

# Requirements Covered
- REM-001
- SYN-002
- AUTH-001
- EVT-001
- OBS-001

# Implementation Tasks
- [ ] Implement Swift-owned `seed`, `clone`, `pull`, `push`, `reconcile`, and WebSocket participation.
- [ ] Read/write changelog and cursor state from the shared Core Data namespace store.
- [ ] Implement native auth providers, static headers, request interception, and WebSocket auth attachment.
- [ ] Route remote-only resources and hydrating-query fallback through the native remote executor.
- [ ] Emit sync status and failures through the bridge.
- [ ] Add JS integration tests that prove embedded server-sync mode does not use JS-owned sync.

# Verification Steps
- `swift test --package-path datafn/swift`
  - Expected: server-sync and auth-parity tests pass.
- `npm --prefix datafn/client test`
  - Expected: native-backed server-sync integration tests pass.

# Stop Condition
Report the server-sync backend event flow, supported auth configuration modes, and passing integration tests before starting Phase 06.
