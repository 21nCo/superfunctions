# REQUIREMENTS

## Table of Contents

| ID | Priority | Summary |
|----|----------|---------|
| LOG-001 | P0 | Pass `logger` to `executeMutation()` in mutation route |
| LOG-002 | P0 | Pass `logger` to `executeTransaction()` in transact route |
| LOG-003 | P0 | Pass `logger` to `executeReconcile()` in sync route |
| LOG-004 | P0 | Add `logger` parameter to `executeClone()` and pass from sync route |
| LOG-005 | P0 | Add `logger` parameter to `createRestRoutes()` and log in all 4 REST handlers |
| LOG-006 | P0 | Add `logger` parameter to `DbDataStore.create()` and `forPushdownResult()` |
| LOG-007 | P0 | Add `logger?.error()` to the outer catch in `executeMutationCore` |
| LOG-008 | P1 | Add logging to all `executeClone` catch blocks |
| LOG-009 | P1 | Add logging to all `executeReconcile` catch blocks |
| LOG-010 | P1 | Log non-duplicate errors in `idempotency-db.ts set()` |
| LOG-011 | P1 | Add `logger` to `recordChangeWithRetry()` and log retries |
| LOG-012 | P1 | Log namespace provider errors in `server.ts` rate limit key extractor |
| LOG-013 | P1 | Log errors in `readBodyWithLimit` middleware |
| LOG-014 | P1 | Add logging to all `DbDataStore` catch blocks |
| SEQ-001 | P1 | Propagate errors in `getLatestServerSeq()` instead of returning 0 |
| SEQ-002 | P1 | Propagate errors in `DatabaseSequenceStore.getCurrent()` instead of returning 0 |
| WS-001 | P2 | Log WebSocket heartbeat ping failures at warn level |
| WS-002 | P2 | Log WebSocket `handleMessage` errors at warn level |
| WS-003 | P2 | Log WebSocket `close()` errors at warn level |
| CAS-001 | P2 | Log CAS retry intermediate failures in `sequence-store.ts` at warn level |
| CAS-002 | P2 | Log CAS retry intermediate failures in `change-tracking.ts` at warn level |
| IDEM-001 | P2 | Narrow `idempotency-db.ts` JSON.parse catch to log unexpected errors |

---

## LOG-001: Pass `logger` to `executeMutation()` in mutation route

- **Priority**: P0
- **Statement**: The mutation route handler MUST pass the `logger` parameter to every `executeMutation()` call.
- **Rationale**: `executeMutation` already accepts `logger` as its 9th parameter, but the route handler at `mutation.ts:134-143` omits it. All `logger?.error()` calls inside `executeMutationCore` are therefore no-ops.
- **Acceptance criteria**:
  - The `executeMutation()` call in `mutation.ts` includes `logger` as the final argument.
  - When a mutation fails with a DB error, the error appears in server logs.
- **Test vectors**: TV-LOG-001
- **Notes**: One-line fix — append `, logger` to the call.

---

## LOG-002: Pass `logger` to `executeTransaction()` in transact route

- **Priority**: P0
- **Statement**: The transact route handler MUST pass the `logger` parameter to `executeTransaction()`.
- **Rationale**: `executeTransaction` accepts `logger` as its 10th parameter, but `transact.ts:184-193` omits it. Transaction-level errors are never logged.
- **Acceptance criteria**:
  - The `executeTransaction()` call in `transact.ts` includes `logger` as the final argument.
  - When a transaction fails with a DB error, the error appears in server logs.
- **Test vectors**: TV-LOG-002
- **Notes**: One-line fix — append `, logger` to the call.

---

## LOG-003: Pass `logger` to `executeReconcile()` in sync route

- **Priority**: P0
- **Statement**: The reconcile route handler MUST pass the `logger` parameter to `executeReconcile()`.
- **Rationale**: `executeReconcile` accepts `logger` as its 6th parameter, but `sync.ts:479-485` omits it. Reconcile errors are never logged.
- **Acceptance criteria**:
  - The `executeReconcile()` call in `sync.ts` includes `logger` as the final argument.
  - When a reconcile DB query fails, the error appears in server logs.
- **Test vectors**: TV-LOG-003
- **Notes**: One-line fix — append `, logger` to the call.

---

## LOG-004: Add `logger` parameter to `executeClone()` and pass from sync route

- **Priority**: P0
- **Statement**: `executeClone()` MUST accept an optional `logger?: DatafnLogger` parameter. The clone route handler in `sync.ts` MUST pass `logger` to `executeClone()`.
- **Rationale**: `executeClone` has 5 bare catch blocks that silently swallow DB errors. The function has no logger parameter, so adding logging requires changing the signature first.
- **Acceptance criteria**:
  - `executeClone` function signature includes `logger?: DatafnLogger` as the last parameter.
  - The clone route handler call at `sync.ts:79-85` passes `logger`.
  - Import of `DatafnLogger` type is added to `clone.ts`.
- **Test vectors**: TV-LOG-004
- **Notes**: Parameter MUST be optional to maintain backward compatibility.

---

## LOG-005: Add `logger` parameter to `createRestRoutes()` and log in all REST handlers

- **Priority**: P0
- **Statement**: `createRestRoutes()` MUST accept an optional `logger?: DatafnLogger` parameter. All 4 REST route handlers (GET, POST, PATCH, DELETE) MUST log errors via `logger?.error(...)` in their catch blocks.
- **Rationale**: REST routes have zero error visibility — all 4 catch blocks return `errorResponse(err)` without logging.
- **Acceptance criteria**:
  - `createRestRoutes` function signature includes `logger?: DatafnLogger` as the last parameter.
  - All 4 catch blocks (`rest.ts` lines ~119, ~193, ~267, ~334) include `logger?.error(...)`.
  - The caller in `server.ts` passes `logger` when calling `createRestRoutes()`.
- **Test vectors**: TV-LOG-005
- **Notes**: Must also update the call site in `server.ts` where `createRestRoutes` is invoked.

---

## LOG-006: Add `logger` parameter to `DbDataStore.create()` and `forPushdownResult()`

- **Priority**: P0
- **Statement**: `DbDataStore.create()` and `DbDataStore.forPushdownResult()` MUST accept an optional `logger?: DatafnLogger` parameter.
- **Rationale**: These functions have 12+ catch blocks that silently replace DB errors with empty arrays. Without a logger parameter, adding logging is impossible.
- **Acceptance criteria**:
  - Both static methods include `logger?: DatafnLogger` in their signatures.
  - Callers of these methods pass `logger` where available.
- **Test vectors**: TV-LOG-006
- **Notes**: `forQuery()` already has a logger parameter.

---

## LOG-007: Add `logger?.error()` to the outer catch in `executeMutationCore`

- **Priority**: P0
- **Statement**: The outer fallback catch block in `executeMutationCore` (`execute.ts:183-185`) MUST log the error via `logger?.error(...)`.
- **Rationale**: This catch wraps all switch cases. If an unexpected error reaches it, the error is silently converted to `{ code: "INTERNAL" }` with no log entry.
- **Acceptance criteria**:
  - The catch block at line 183-185 includes `logger?.error("Unexpected mutation error", { error: String(error), operation: mutation.operation, resource: mutation.resource })`.
- **Test vectors**: TV-LOG-007
- **Notes**: `logger` is already available in scope (function parameter).

---

## LOG-008: Add logging to all `executeClone` catch blocks

- **Priority**: P1
- **Statement**: All catch blocks in `executeClone` (lines ~187, ~226, ~246, ~292) MUST log the error via `logger?.warn(...)`.
- **Rationale**: Clone failures are invisible. DB errors are silently converted to empty data.
- **Acceptance criteria**:
  - Each catch block calls `logger?.warn("Clone: <context>", { error: String(error), resource: tableName })`.
  - The graceful fallback behavior (empty array, cursor "0") is preserved.
- **Test vectors**: TV-LOG-008
- **Notes**: Uses `warn` because clone continues gracefully — individual table failures don't fail the whole clone.

---

## LOG-009: Add logging to all `executeReconcile` catch blocks

- **Priority**: P1
- **Statement**: Both catch blocks in `executeReconcile` (lines ~119, ~161) MUST log the error via `logger?.warn(...)`.
- **Rationale**: Reconcile count errors are invisible and can trigger unnecessary re-clones.
- **Acceptance criteria**:
  - Each catch block calls `logger?.warn("Reconcile: <context>", { error: String(error), resource: resourceName })`.
  - The graceful fallback behavior (count = 0) is preserved.
- **Test vectors**: TV-LOG-009
- **Notes**: Uses `warn` because reconcile continues gracefully.

---

## LOG-010: Log non-duplicate errors in `idempotency-db.ts set()`

- **Priority**: P1
- **Statement**: The catch block in `DatabaseIdempotencyStore.set()` MUST distinguish duplicate key errors from other errors. Non-duplicate errors MUST be logged at warn level.
- **Rationale**: Currently ALL errors are silently swallowed. Connection failures, schema errors, and permission errors are invisible.
- **Acceptance criteria**:
  - Duplicate key errors (code `23505`, `UNIQUE_VIOLATION`, `ER_DUP_ENTRY`, `SQLITE_CONSTRAINT_UNIQUE`, or message containing "unique"/"duplicate"/"conflict") are still silently ignored.
  - All other errors are logged via `logger?.warn("Idempotency store set failed", { error: String(error) })`.
  - The function signature gains `logger?: DatafnLogger` (or the class gains a logger property).
- **Test vectors**: TV-LOG-010
- **Notes**: The class constructor should accept `logger` so it's available in all methods.

---

## LOG-011: Add `logger` to `recordChangeWithRetry()` and log retries

- **Priority**: P1
- **Statement**: `recordChangeWithRetry()` MUST accept a `logger?: DatafnLogger` parameter and log intermediate retry failures at warn level.
- **Rationale**: Retry failures are invisible. The function retries up to 2 times with no visibility into what's failing.
- **Acceptance criteria**:
  - Function signature includes `logger?: DatafnLogger`.
  - Each retry logs: `logger?.warn("Change tracking retry", { attempt: i+1, error: String(e) })`.
  - All callers of `recordChangeWithRetry` pass `logger`.
- **Test vectors**: TV-LOG-011
- **Notes**: Small change — function is internal to `push.ts`.

---

## LOG-012: Log namespace provider errors in `server.ts` rate limit key extractor

- **Priority**: P1
- **Statement**: The `defaultKeyExtractor` catch block in `server.ts` MUST log the error at warn level.
- **Rationale**: A broken namespace provider is completely invisible — rate limiting silently falls back to "anonymous".
- **Acceptance criteria**:
  - The catch block includes `logger.warn("Namespace provider failed for rate limiting, using anonymous", { error: String(error) })`.
- **Test vectors**: TV-LOG-012
- **Notes**: `logger` is available in the enclosing scope.

---

## LOG-013: Log errors in `readBodyWithLimit` middleware

- **Priority**: P1
- **Statement**: The `readBodyWithLimit` catch block in `http/middleware.ts` SHOULD log the error. If logger is not directly available, a `logger` parameter MUST be added to the function.
- **Rationale**: Request body reading failures (streaming errors, connection resets) are completely invisible.
- **Acceptance criteria**:
  - The catch block logs: `logger?.warn("Failed to read request body", { error: String(error) })`.
  - Function signature includes `logger?: DatafnLogger` if not already available in scope.
- **Test vectors**: TV-LOG-013
- **Notes**: Evaluate whether logger can be passed from the caller or if the middleware needs restructuring.

---

## LOG-014: Add logging to all `DbDataStore` catch blocks

- **Priority**: P1
- **Statement**: All 12+ catch blocks in `DbDataStore.create()`, `forPushdownResult()`, and `loadJoinRows()` MUST log the error at warn level.
- **Rationale**: Relation loading failures during query execution are completely invisible.
- **Acceptance criteria**:
  - Each catch block calls `logger?.warn("<context>", { error: String(error), resource: <resource> })`.
  - Graceful fallback (empty array) is preserved.
- **Test vectors**: TV-LOG-014
- **Notes**: Depends on LOG-006 (adding logger parameter to these functions).

---

## SEQ-001: Propagate errors in `getLatestServerSeq()` instead of returning 0

- **Priority**: P1
- **Statement**: `ChangeTrackingService.getLatestServerSeq()` MUST propagate DB errors instead of returning `0`.
- **Rationale**: Returning 0 on error causes callers to set cursor to "0", potentially causing clients to re-fetch all data or miss changes.
- **Acceptance criteria**:
  - The catch block re-throws the error after logging.
  - Callers of `getLatestServerSeq()` handle the thrown error appropriately (catch and use fallback if needed).
  - The `return 0` is removed from the catch block.
- **Test vectors**: TV-SEQ-001
- **Notes**: Callers in `clone.ts` and `push.ts` already have their own catch blocks, so they will catch the propagated error. Those callers' catch blocks already handle errors gracefully (empty data/cursor "0"). This change moves the error handling decision to the caller where it belongs.

---

## SEQ-002: Propagate errors in `DatabaseSequenceStore.getCurrent()` instead of returning 0

- **Priority**: P1
- **Statement**: `DatabaseSequenceStore.getCurrent()` MUST propagate DB errors instead of returning `0`.
- **Rationale**: Same as SEQ-001 — returning 0 masks DB failures and could cause sequence collisions.
- **Acceptance criteria**:
  - The catch block re-throws the error after logging.
  - Callers handle the thrown error appropriately.
  - The `return 0` is removed from the catch block.
- **Test vectors**: TV-SEQ-002
- **Notes**: Must audit all callers of `getCurrent()` to ensure they have error handling.

---

## WS-001: Log WebSocket heartbeat ping failures at warn level

- **Priority**: P2
- **Statement**: The WebSocket heartbeat ping catch block (`ws.ts:101-106`) SHOULD log the failure at warn level.
- **Rationale**: Connection issues are invisible when ping failures are silent.
- **Acceptance criteria**:
  - Catch block includes `this.logger?.warn("Heartbeat ping failed", { error: String(e) })`.
- **Test vectors**: TV-WS-001
- **Notes**: Minor — connection cleanup already works correctly.

---

## WS-002: Log WebSocket `handleMessage` errors at warn level

- **Priority**: P2
- **Statement**: The `handleMessage` catch block (`ws.ts:188-190`) SHOULD log non-JSON-parse errors at warn level.
- **Rationale**: All exceptions (not just JSON parse) are silently swallowed.
- **Acceptance criteria**:
  - Catch block includes `this.logger?.warn("WebSocket message handling error", { error: String(e) })`.
- **Test vectors**: TV-WS-002
- **Notes**: Low severity — current handler only checks for "hello" messages.

---

## WS-003: Log WebSocket `close()` errors at warn level

- **Priority**: P2
- **Statement**: The `close()` catch block (`ws.ts:228-230`) SHOULD log the failure at warn level.
- **Rationale**: Shutdown errors are invisible.
- **Acceptance criteria**:
  - Catch block includes `this.logger?.warn("WebSocket close error", { error: String(e) })`.
- **Test vectors**: TV-WS-003
- **Notes**: Expected during shutdown — warn level is appropriate.

---

## CAS-001: Log CAS retry intermediate failures in `sequence-store.ts`

- **Priority**: P2
- **Statement**: CAS retry loops in `DatabaseSequenceStore` SHOULD log intermediate failures at warn level.
- **Rationale**: Only final failures are logged; intermediate retries are invisible.
- **Acceptance criteria**:
  - Each `catch` in the retry loop logs: `this.logger?.warn("Sequence allocation retry", { attempt, error: String(error) })`.
- **Test vectors**: TV-CAS-001
- **Notes**: Lines ~188-190 and ~209-211 in `sequence-store.ts`.

---

## CAS-002: Log CAS retry intermediate failures in `change-tracking.ts`

- **Priority**: P2
- **Statement**: CAS retry loops in `ChangeTrackingService` SHOULD log intermediate failures at warn level.
- **Rationale**: Same as CAS-001.
- **Acceptance criteria**:
  - Each `catch` in the CAS retry loop logs at warn level.
- **Test vectors**: TV-CAS-002
- **Notes**: Lines ~157-168 in `change-tracking.ts`.

---

## IDEM-001: Narrow `idempotency-db.ts` JSON.parse catch

- **Priority**: P2
- **Statement**: The `get()` method's catch block in `idempotency-db.ts` (~line 44-46) SHOULD log unexpected errors at warn level.
- **Rationale**: Comment says "malformed JSON" but catches all errors.
- **Acceptance criteria**:
  - If the error is a `SyntaxError`, silently return `null` (expected — malformed JSON).
  - For other error types, log at warn level before returning `null`.
- **Test vectors**: TV-IDEM-001
- **Notes**: Very low risk.
