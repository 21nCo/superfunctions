# Issue Completion Report: Full Audit Findings Fix (2026-02-26)

## Metadata
- **Timestamp**: 2026-02-26T07:05:00Z
- **Agent**: unknown-agent
- **Model**: Claude Opus 4.6 (1M context)
- **Launcher**: CLI
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions/datafn
- **OS**: Darwin 25.3.0 / zsh
- **Branch**: next
- **Commit**: ea87d7e (dirty: yes — 13 files changed)
- **Issue file**: datafn/.conduct/audits/2026-02-26-289dbdab-full-audit.md

## Issue Summary

Comprehensive fix of 12 findings from the full production-readiness audit (289dbdab). Covers all 6 NEW issues (critical + warning), plus fixes for previously-reported items S-2, T-1, T-2/NEW-2, F-1, F-2, and P-4.

## Status: PASS

## Requirements Summary

### NEW-1 (CRITICAL): executeTransaction missing plugins/namespace args
- **Status**: PASS
- **Evidence**: Added `plugins: DatafnPlugin[]` parameter to `executeTransaction()` and `createTransactHandler()`. Both `plugins` and `namespace` now passed through to `executeMutation()` in `executeStep`. Server.ts updated to pass `config.plugins` to transact handler.
- **Files**: transact.ts, routes/transact.ts, server.ts
- **Tests**: 84/84 pass including transact.test.ts

### P-2: Content-Length only payload limit
- **Status**: PASS
- **Evidence**: Added `readBodyWithLimit()` in middleware.ts that reads body text and enforces size limit even when Content-Length header is absent. `withAuth` in server.ts now uses `readBodyWithLimit` for POST requests when maxPayloadBytes is set.
- **Files**: http/middleware.ts, server.ts

### NEW-2 / T-2: Double invocation of enforcePayloadLimit + sentinel pattern
- **Status**: PASS
- **Evidence**: Replaced double limiter invocation + sentinel pattern with single inline `checkPayloadLimit()` call + `readBodyWithLimit()`. No more Response object allocations for sentinel.
- **Files**: http/middleware.ts, server.ts

### T-1: Dynamic import in hot path
- **Status**: PASS
- **Evidence**: Converted `await import("./http/json.js")` to static `import { parseJsonBody } from "./http/json.js"` at top of server.ts.
- **Files**: server.ts

### NEW-3: MemoryRateLimiter unbounded memory growth
- **Status**: PASS
- **Evidence**: Added periodic sweep timer (default 60s) to `MemoryRateLimiter` that removes expired window entries. Added `destroy()` method. Server `close()` now calls `destroy()` on the memory rate limiter.
- **Files**: middleware/rate-limit.ts, server.ts

### NEW-4: Aggregate group key collision risk
- **Status**: PASS
- **Evidence**: Replaced `keyParts.join("||")` with `JSON.stringify(keyParts)` for collision-safe composite keys. Removed dead `key.split("||")` code.
- **Files**: execution/query/aggregate.ts

### NEW-5: WebSocket broadcasts ignore namespace
- **Status**: PASS
- **Evidence**: `WebSocketManager` now tracks client namespace via `clientNamespaces` Map, set on `hello` message. `broadcastCursor()` accepts optional `namespace` parameter and filters clients. `ChangeTrackingService.onChange` callback updated to pass `(seq, namespace)`. Push handler and server.ts updated to thread namespace through.
- **Files**: ws.ts, execution/sync/change-tracking.ts, execution/sync/push.ts, routes/sync.ts, server.ts

### NEW-6: Authorization bypass for system fields
- **Status**: PASS
- **Evidence**: Only `id` unconditionally bypasses authz. System fields (createdAt, updatedAt, createdBy, updatedBy, isArchived) now respect `permissions.read.fields` policy when defined. Both `validateQueryAuthz` (select) and `extractFieldsFromFilter` (filters) updated.
- **Files**: validation/authz.ts

### S-2: Replace JSON deep clone with structuredClone
- **Status**: PASS
- **Evidence**: All 6 occurrences of `JSON.parse(JSON.stringify(...))` in `MemoryStore` (snapshot, fromSnapshot, commitSnapshot) replaced with `structuredClone()`.
- **Files**: execution/memory-store.ts

### F-1: Surface change tracking failures
- **Status**: PASS
- **Evidence**: Change tracking catch block in `executeMutation` now re-throws error after logging instead of silently swallowing.
- **Files**: execution/mutation/execute.ts

### F-2: getGlobalChanges returns empty on error
- **Status**: PASS
- **Evidence**: Both `getGlobalChanges()` and `getChangesSince()` now throw errors instead of returning empty arrays, preventing clients from falsely believing they are fully synced.
- **Files**: execution/sync/change-tracking.ts

### P-4: Remove verbose debug logging
- **Status**: PASS
- **Evidence**: Replaced `console.log("Transact Step Error:", e)` with structured `console.error("Transact step error:", e?.message || e)`.
- **Files**: execution/transact.ts

## Implementation Summary

### Files changed (13):
1. `datafn/server/src/execution/transact.ts` — Added plugins param, fixed executeMutation call, cleaned up logging
2. `datafn/server/src/routes/transact.ts` — Added plugins param, passes to executeTransaction
3. `datafn/server/src/server.ts` — Static import for json.js, simplified withAuth (no sentinel/double invocation), passes plugins to transact, rate limiter cleanup on close
4. `datafn/server/src/http/middleware.ts` — Added checkPayloadLimit(), readBodyWithLimit(), deprecated enforcePayloadLimit()
5. `datafn/server/src/middleware/rate-limit.ts` — MemoryRateLimiter sweep timer + destroy()
6. `datafn/server/src/execution/query/aggregate.ts` — JSON.stringify for group keys
7. `datafn/server/src/ws.ts` — Namespace-scoped broadcasts
8. `datafn/server/src/execution/sync/change-tracking.ts` — onChange passes namespace, throw on error
9. `datafn/server/src/execution/sync/push.ts` — Updated onChange signature
10. `datafn/server/src/routes/sync.ts` — Updated onChange signature
11. `datafn/server/src/validation/authz.ts` — Only id bypasses authz
12. `datafn/server/src/execution/memory-store.ts` — structuredClone
13. `datafn/server/src/execution/mutation/execute.ts` — Propagate change tracking errors

## Verification Summary

### Test execution:
- **Command**: `npx vitest run server/src --reporter=verbose`
- **Result**: 10 test files, 84 tests, ALL PASSED
- **Duration**: 859ms

### Type checking:
- **Command**: `npx tsc --noEmit --project server/tsconfig.json`
- **Result**: No new errors introduced. Pre-existing TS2709 namespace-as-type errors remain (unrelated to changes).

## Notes
- The `enforcePayloadLimit` middleware function is kept but marked `@deprecated` for backward compatibility
- WebSocket namespace filtering is backward-compatible: clients that don't send namespace in hello still receive all broadcasts
- The `MemoryRateLimiter.destroy()` method should be called on server shutdown to prevent timer leaks — integrated into `DatafnServer.close()`
- F-1 fix (re-throw change tracking errors) may cause previously-silent failures to surface as 500s — this is intentional and correct behavior
- F-2 fix (throw instead of empty array) may cause pull endpoints to return error responses when DB is unavailable — this is correct (empty array falsely implies "synced")
