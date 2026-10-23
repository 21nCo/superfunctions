# TEST VECTORS

## Verification Approach

Since these fixes are about error logging behavior, test vectors verify that:
1. Logger receives the expected calls on error paths.
2. The function's return value / response to the client is unchanged.
3. Happy-path behavior is unaffected.

Tests should use a mock logger (object with `error`, `warn`, `info` as `vi.fn()`) to verify calls.

---

## TV-LOG-001: `executeMutation` receives logger from mutation route

- **Description**: When a mutation fails with a DB error, `logger.error` is called.
- **Input**: Call `executeMutation` with a failing mutation (e.g., insert into non-existent resource) and a mock logger.
- **Expected output**: `logger.error` called with first argument containing "insert" or "Mutation" and second argument containing `{ error: <string>, operation: <string>, resource: <string> }`.
- **Negative variant**: Call `executeMutation` WITHOUT logger — no crash, `logger?.error()` is simply a no-op.

---

## TV-LOG-002: `executeTransaction` receives logger from transact route

- **Description**: When a transaction fails, the error is logged.
- **Input**: Call `executeTransaction` with a step that throws, and a mock logger.
- **Expected output**: `logger.error` called with error context.
- **Negative variant**: Same call without logger — no crash.

---

## TV-LOG-003: `executeReconcile` receives logger from sync route

- **Description**: When reconcile DB count fails, `logger.warn` is called.
- **Input**: Call `executeReconcile` with a DB adapter whose `findMany` throws, and a mock logger.
- **Expected output**: `logger.warn` called with reconcile context. Result still returns `counts` with `0` for failed resources.
- **Negative variant**: Without logger — no crash, same graceful fallback.

---

## TV-LOG-004: `executeClone` receives logger

- **Description**: When clone's `db.findMany` throws for a table, `logger.warn` is called.
- **Input**: Call `executeClone` with a DB adapter whose `findMany` throws for one resource, and a mock logger.
- **Expected output**: `logger.warn` called with clone context. That resource gets empty array in result. Other resources unaffected.
- **Negative variant**: Without logger — same behavior as before (silent empty array).

---

## TV-LOG-005: REST route handlers log errors

- **Description**: When a REST GET query fails, logger is called.
- **Input**: Send GET `/datafn/resources/nonexistent` to REST route handler where `executeQuery` throws.
- **Expected output**: `logger.error` called with REST context. Response is error with status 500.
- **Negative variant**: Without logger (backward compat) — same 500 response, no crash.

---

## TV-LOG-006: `DbDataStore.create()` logs on error

- **Description**: When `db.findMany` throws during DataStore creation, `logger.warn` is called.
- **Input**: Call `DbDataStore.create(failingDb, ["todos"], "test-ns", undefined, undefined, mockLogger)`.
- **Expected output**: `logger.warn` called. Store has empty records for "todos".
- **Negative variant**: Without logger — same empty records, no crash.

---

## TV-LOG-007: `executeMutationCore` outer catch logs

- **Description**: When an unexpected error reaches the outer catch in `executeMutationCore`, `logger.error` is called.
- **Input**: A mutation where the inner switch-case throw is not caught by inner handlers (e.g., unknown operation type that bypasses inner try-catch).
- **Expected output**: `logger.error` called with `{ error: <string> }`. Result has `code: "INTERNAL"`.
- **Negative variant**: Without logger — same `INTERNAL` result, no crash.

---

## TV-LOG-008: `executeClone` catch blocks log with warn

- **Description**: Each of the 5 clone catch blocks calls `logger.warn` on error.
- **Input**: DB adapter that throws on `count()`, `findMany()` for specific tables.
- **Expected output**: `logger.warn` called once per failed operation with `{ error: <string>, resource: <tableName> }`.
- **Negative variant**: Same call with no logger — graceful fallback, no crash.

---

## TV-LOG-009: `executeReconcile` catch blocks log with warn

- **Description**: Both reconcile catch blocks call `logger.warn` on DB error.
- **Input**: DB adapter that throws on `count()` for a specific resource.
- **Expected output**: `logger.warn` called with `{ error: <string>, resource: <resourceName> }`. Count for that resource is 0.
- **Negative variant**: No logger — same behavior.

---

## TV-LOG-010: `idempotency-db.ts set()` distinguishes duplicate key errors

- **Description**: Duplicate key errors are expected and silent. Other errors are logged.
- **Input (positive — dup key)**: Call `set()` where `db.internal.create` throws `{ code: "23505" }`. Logger NOT called.
- **Input (negative — connection error)**: Call `set()` where `db.internal.create` throws `{ code: "ECONNREFUSED" }`. Logger `warn` IS called.
- **Expected output**: Dup key → no log. Connection error → `logger.warn("Idempotency store set failed (non-duplicate)", ...)`.

---

## TV-LOG-011: `recordChangeWithRetry` logs intermediate retries

- **Description**: When change tracking fails and retries, intermediate failures are logged.
- **Input**: `changeTracking.recordChange` fails twice then succeeds on 3rd attempt. Mock logger provided.
- **Expected output**: `logger.warn` called 2 times (once per retry). Final result is success (no throw).
- **Negative variant**: All 3 attempts fail — `logger.warn` called 2 times, then error is thrown.

---

## TV-LOG-012: Namespace provider error logged in rate limit key extractor

- **Description**: When `namespaceProvider.getNamespace()` throws, `logger.warn` is called.
- **Input**: `config.namespaceProvider.getNamespace` throws `new Error("auth failed")`.
- **Expected output**: `logger.warn` called with namespace provider context. Return value is `"anonymous"`.

---

## TV-LOG-013: `readBodyWithLimit` logs body read errors

- **Description**: When `req.text()` throws, the error is logged.
- **Input**: A request object whose `.text()` throws `new Error("stream error")`. Mock logger provided.
- **Expected output**: `logger.warn` called. Response is `{ code: "DFQL_INVALID", message: "Failed to read request body" }` with status 400.

---

## TV-LOG-014: `DbDataStore` catch blocks log at warn level

- **Description**: All 12+ catch blocks in DbDataStore log errors.
- **Input**: DB adapter that throws on `findMany` for a specific relation/join table.
- **Expected output**: `logger.warn` called with relation/resource context. Store has empty data for that relation.

---

## TV-SEQ-001: `getLatestServerSeq()` propagates errors

- **Description**: When the DB query fails, `getLatestServerSeq()` throws instead of returning 0.
- **Input**: `db.internal.findMany` for `__datafn_changes` throws `new Error("connection refused")`.
- **Expected output**: `getLatestServerSeq()` throws the error. `logger.error` is called before throwing.
- **Negative variant**: When `db.internal.findMany` returns empty array, function returns `0` (not an error).

---

## TV-SEQ-002: `DatabaseSequenceStore.getCurrent()` propagates errors

- **Description**: When the DB query fails, `getCurrent()` throws instead of returning 0.
- **Input**: `db.internal.findOne` for `__datafn_meta` throws `new Error("connection refused")`.
- **Expected output**: `getCurrent()` throws the error. `logger.error` is called before throwing.
- **Negative variant**: When `db.internal.findOne` returns `null`, function returns `0` (not an error).

---

## TV-WS-001: WebSocket heartbeat ping failure logged

- **Description**: When `client.ping()` throws, `logger.warn` is called.
- **Input**: Mock client whose `ping()` throws. WsManager with mock logger.
- **Expected output**: `logger.warn` called with heartbeat context. Client is removed and closed.

---

## TV-WS-002: WebSocket `handleMessage` error logged

- **Description**: When message handling throws a non-parse error, `logger.warn` is called.
- **Input**: Data string that causes `JSON.parse` to throw.
- **Expected output**: `logger.warn` called with message handling context.

---

## TV-WS-003: WebSocket `close()` error logged

- **Description**: When `client.close()` throws during shutdown, `logger.warn` is called.
- **Input**: Mock client whose `close()` throws.
- **Expected output**: `logger.warn` called. Other clients still closed.

---

## TV-CAS-001: Sequence store CAS retry logs intermediate failures

- **Description**: CAS retry intermediate failures are logged at warn level.
- **Input**: `db.internal.update` fails twice then succeeds. Mock logger on sequence store.
- **Expected output**: `logger.warn` called 2 times with retry context.

---

## TV-CAS-002: Change tracking CAS retry logs intermediate failures

- **Description**: Same as TV-CAS-001 but for change tracking CAS.
- **Input**: CAS update fails once then succeeds.
- **Expected output**: `logger.warn` called once with retry context.

---

## TV-IDEM-001: Idempotency `get()` JSON.parse catch narrowed

- **Description**: `SyntaxError` from `JSON.parse` returns null silently. Other errors are logged.
- **Input (positive)**: Stored result is `"not-valid-json{}"`. `get()` returns `null`. No warn log.
- **Input (negative)**: Somehow a non-SyntaxError is thrown during parse. `get()` returns `null`. `logger.warn` IS called.
