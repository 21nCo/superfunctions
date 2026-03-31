# Phase Goal
Implement the concrete `WKWebView` bridge bus and the native-backed TypeScript adapters for storage, remote routing, and sync control.

# In Scope / Out Of Scope
- In scope:
  - `WKWebView` message-handler bus implementation.
  - Native-backed storage adapter.
  - Native-backed remote adapter.
  - Native sync controller implementation.
- Out of scope:
  - `@datafn/client` integration.
  - Swift host implementation.

# Deliverables
- `datafn/swift-bridge/src/wkwebviewBus.ts`
- `datafn/swift-bridge/src/nativeStorage.ts`
- `datafn/swift-bridge/src/nativeRemote.ts`
- `datafn/swift-bridge/src/nativeSyncController.ts`
- `datafn/swift-bridge/src/index.ts`
- `datafn/swift-bridge/__tests__/wkwebviewBus.test.ts`
- `datafn/swift-bridge/__tests__/nativeStorage.test.ts`
- `datafn/swift-bridge/__tests__/nativeRemote.test.ts`
- `datafn/swift-bridge/__tests__/nativeSyncController.test.ts`

# Requirements Covered
- API-002
- BRG-001
- STO-001
- QRY-001
- SYN-001

# Implementation Tasks
- [ ] Implement request/response correlation with timeout handling on top of `window.webkit.messageHandlers`.
- [ ] Implement subscription/event delivery from native host to JavaScript.
- [ ] Implement all `DatafnStorageAdapter` methods via bridge method mapping.
- [ ] Implement all `DatafnRemoteAdapter` methods via bridge method mapping.
- [ ] Implement native sync controller methods, including `schedulePush()`.
- [ ] Add fail-fast behavior when the bridge bus is unavailable.
- [ ] Add tests for timeout, unsupported methods, and event subscription teardown.

# Verification Steps
- `npm --prefix datafn/swift-bridge test`
  - Expected: adapter and bus tests pass.
- `npm --prefix datafn/swift-bridge run typecheck`
  - Expected: public exports and adapter implementations typecheck.

# Stop Condition
Report the bridge method map, timeout behavior, and passing bridge adapter tests before starting Phase 02.
