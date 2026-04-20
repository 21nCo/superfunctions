# Phase Goal
Integrate native-backed mode into `@datafn/client` without regressing browser-owned IndexedDB mode.

# In Scope / Out Of Scope
- In scope:
  - Native-backed config validation and initialization.
  - Query, mutation, transaction, and sync facade integration.
  - Browser-mode non-regression coverage.
- Out of scope:
  - Swift runtime implementation.
  - SwiftUI bindings.

# Deliverables
- `datafn/client/src/client.ts`
- `datafn/client/src/query.ts`
- `datafn/client/src/mutate.ts`
- `datafn/client/src/transact.ts`
- `datafn/client/src/sync.ts`
- `datafn/client/src/index.ts`
- `datafn/client/__tests__/native-backed-mode.test.ts`
- `datafn/client/__tests__/browser-mode-regression.test.ts`

# Requirements Covered
- API-001
- QRY-001
- REM-001
- MUT-001
- SYN-001
- COMP-001

# Implementation Tasks
- [ ] Wire `sync.owner = "native"` initialization to use the native sync controller instead of the JS `SyncEngine`.
- [ ] Keep existing browser-owned `remote` and IndexedDB flows unchanged.
- [ ] Ensure ready-resource local-first mutations still schedule native push via `schedulePush()`.
- [ ] Ensure hydrating-resource and batch-query routing use the native-backed remote adapter.
- [ ] Ensure remote-only resource handling matches the spec for `datafn-server` and `icloud` modes.
- [ ] Fail fast when native-backed mode is configured without a bridge or with forbidden direct `remote` ownership.
- [ ] Add regression tests proving no IndexedDB usage in native-backed mode and continued IndexedDB usage in browser mode.

# Verification Steps
- `npm --prefix datafn/client test`
  - Expected: native-backed and browser-regression tests pass.
- `npm --prefix datafn/client run typecheck`
  - Expected: client public API remains type-safe.

# Stop Condition
Report the passing browser-vs-native mode matrix and the exact guard that prevents IndexedDB fallback before starting Phase 03.
