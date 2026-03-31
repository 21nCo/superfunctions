# Phase Goal
Establish the shared TypeScript contracts for native-backed mode, including config validation, bridge protocol types, and new error codes.

# In Scope / Out Of Scope
- In scope:
  - `@datafn/core` error-code additions.
  - `@datafn/client` config type changes for `sync.owner = "native"`.
  - `@datafn/swift-bridge` package scaffolding and protocol types.
- Out of scope:
  - Concrete `WKWebView` transport implementation.
  - Swift runtime implementation.

# Deliverables
- `datafn/core/src/errors.ts`
- `datafn/client/src/client.ts`
- `datafn/client/src/index.ts`
- `datafn/swift-bridge/package.json`
- `datafn/swift-bridge/tsconfig.json`
- `datafn/swift-bridge/vitest.config.ts`
- `datafn/swift-bridge/src/protocol.ts`
- `datafn/swift-bridge/src/index.ts`
- `datafn/swift-bridge/__tests__/protocol.test.ts`

# Requirements Covered
- PKG-001
- API-001
- API-002
- BRG-001

# Implementation Tasks
- [ ] Add `BRIDGE_UNAVAILABLE`, `BRIDGE_PROTOCOL_MISMATCH`, `BRIDGE_METHOD_UNSUPPORTED`, `NATIVE_SYNC_CONFLICT`, and `ICLOUD_UNAVAILABLE` to `@datafn/core`.
- [ ] Extend `DatafnSyncConfig` with `owner` and `native` definitions in `@datafn/client`.
- [ ] Add config validation rules for native-backed mode in `datafn/client/src/client.ts`.
- [ ] Create the `datafn/swift-bridge/` npm package with the public type exports from the spec.
- [ ] Implement canonical bridge request/response/event types in `protocol.ts`.
- [ ] Add unit tests for valid and invalid protocol envelopes.

# Verification Steps
- `npm --prefix datafn/swift-bridge test`
  - Expected: protocol tests pass.
- `npm --prefix datafn/client run typecheck`
  - Expected: updated client config types compile.
- `npm --prefix datafn/core test`
  - Expected: core error-code additions do not break envelope tests.

# Stop Condition
Report the final `sync.owner` TypeScript shape, the exported bridge protocol types, and the passing test commands before starting Phase 01.
