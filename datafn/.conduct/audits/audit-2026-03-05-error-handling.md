# Audit Report: Error Handling — Silent Swallowing, Missing Logger Propagation, Generic Client Messages

## Metadata

- **Timestamp**: 2026-03-05T12:00:00Z
- **Scope**: `datafn/server/src/`, `packages/db/src/adapter/`
- **Trigger**: Issue `2026-03-03-r4k7m9x3` identified 3 root causes of swallowed errors in the push/mutation path. This audit expands that investigation to the **entire datafn server codebase**.
- **Method**: Read-only — no edits made
- **Branch**: `next`

---

## Categories of Issues

| Category | Code | Description |
|----------|------|-------------|
| **SWALLOW** | Catch block discards error with no logging |
| **NO-LOGGER** | Function lacks `logger` parameter, so cannot log errors even if it wanted to |
| **LOGGER-NOT-PASSED** | Caller has `logger` in scope but does not pass it to child function |
| **GENERIC-MSG** | Error logged server-side but client receives only `"Internal error"` — actual error details lost |
| **RETURN-ZERO** | Error caught and function returns `0` instead of propagating — caller cannot distinguish "no data" from "database error" |

---

## CRITICAL Findings

### C-01: `executeMutation` called without `logger` from mutation route handler

- **File**: `datafn/server/src/routes/mutation.ts:134-143`
- **Category**: LOGGER-NOT-PASSED
- **Impact**: All `/datafn/mutation` endpoint errors inside `executeMutationCore` are logged via `logger?.error(...)` — but `logger` is `undefined` because the route handler never passes it. Every `logger?.error()` in `execute.ts` is a no-op for this code path.

```typescript
// mutation.ts:134-143
for (const mut of transformedMutations) {
  const result = await executeMutation(
    mut as DFQLMutation,
    validatedSchema,
    db,
    idempotencyStore,
    changeTracking,
    plugins,
    namespace,
    // ← logger (9th param) NOT PASSED — available in outer scope
  );
  results.push(result);
}
```

**Note**: The `executeMutation` function signature accepts `logger` as the 9th parameter (`execute.ts:28`).

---

### C-02: `executeTransaction` called without `logger` from transact route handler

- **File**: `datafn/server/src/routes/transact.ts:184-193`
- **Category**: LOGGER-NOT-PASSED
- **Impact**: Transaction-level errors in `transact.ts:127-161` (DB-level errors, transaction rollback) are never logged. The function has `logger?: DatafnLogger` as 9th param but it's never passed.

```typescript
// transact.ts:184-193
const result = await executeTransaction(
  { ...body, steps: normalizedSteps },
  validatedSchema,
  db,
  idempotencyStore,
  limits,
  namespace,
  sequenceStore,
  plugins,
  // ← logger (10th param) NOT PASSED — available in outer scope
);
```

---

### C-03: `executeReconcile` called without `logger` from sync route handler

- **File**: `datafn/server/src/routes/sync.ts:479-485`
- **Category**: LOGGER-NOT-PASSED
- **Impact**: `executeReconcile` accepts `logger` as 6th param but the route handler doesn't pass it. The function's catch blocks at lines 119-122 and 161-164 already swallow errors silently, but even if they were fixed to log, `logger` would be `undefined`.

```typescript
// sync.ts:479-485
const result = await executeReconcile(
  beforeHookResult.payload as any,
  validatedSchema,
  db,
  namespace,
  sequenceStore,
  // ← logger (6th param) NOT PASSED
);
```

---

### C-04: `executeClone` has no `logger` parameter at all

- **File**: `datafn/server/src/execution/sync/clone.ts:40-47`
- **Category**: NO-LOGGER
- **Impact**: The function contains **5 bare catch blocks** (lines 187, 226, 246, 292) that silently swallow database errors. Since the function has no logger parameter, there is no way to log errors even if you added logging to the catch blocks without first changing the signature.

```typescript
// clone.ts:40-47
export async function executeClone(
  request: CloneRequest,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
  maxCloneRecords: number = 10_000,
  // ← no logger parameter
): Promise<CloneResult> {
```

---

### C-05: REST routes have no access to `logger` at all

- **File**: `datafn/server/src/routes/rest.ts:43-47`
- **Category**: NO-LOGGER
- **Impact**: All 4 REST route handlers (GET, POST, PATCH, DELETE) catch exceptions but cannot log them. The `createRestRoutes` function signature does not accept a logger. All REST API errors are completely invisible to server-side monitoring.

```typescript
// rest.ts:43-47
export function createRestRoutes<TContext>(
  schema: DatafnSchema,
  executeMutation: MutationExecutor,
  executeQuery: QueryExecutor,
  // ← no logger parameter
): Route<TContext>[] {
```

Affected catch blocks: lines 119-124, 193-198, 267-272, 334-339 — all return `errorResponse(err)` without logging.

---

## HIGH Findings

### H-01: `DbDataStore.create()` and `forPushdownResult()` — 12+ silent catch blocks, no logger

- **File**: `datafn/server/src/execution/db-store.ts`
- **Category**: SWALLOW + NO-LOGGER
- **Lines**: 52-54, 139-141, 154-156, 169-171, 191-193, 210-212, 242-244, 310-312, 333-335, 347-349, 364-366, 664-666, 855-857
- **Impact**: When relation loading fails during query execution (e.g., join table doesn't exist, connection drops, permission error), the error is silently replaced with an empty array. The caller gets empty data and cannot distinguish it from a genuinely empty result. Neither `create()` nor `forPushdownResult()` accept a `logger` parameter.

```typescript
// db-store.ts:52-54 (representative example — 12+ identical patterns)
} catch (error) {
  store.recordsCache.set(resource, []);
}
```

---

### H-02: `executeClone` — 5 bare catch blocks silently return empty data

- **File**: `datafn/server/src/execution/sync/clone.ts`
- **Category**: SWALLOW
- **Lines**: 187-189, 226-229, 246-249, 292-295
- **Impact**: Clone failures are invisible. If a database error occurs during initial data sync, the client receives empty arrays instead of actual data and has no way to know the clone failed. This could lead to data loss if the client treats the empty clone as authoritative.

```typescript
// clone.ts:187-189
} catch {
  tableCounts[tableName] = 0;  // DB error → count of 0
}

// clone.ts:226-229
} catch {
  data[tableName] = [];          // DB error → empty data
  cursors[tableName] = "0";      // cursor reset
}

// clone.ts:292-295
} catch (error) {
  continue;                      // join table error → silently skip
}
```

---

### H-03: `executeReconcile` — catch blocks discard errors despite `logger` being in scope

- **File**: `datafn/server/src/execution/sync/reconcile.ts`
- **Category**: SWALLOW
- **Lines**: 119-122, 161-164
- **Impact**: Reconcile is used for drift detection. If the database fails during count, the server reports 0 records — the client may interpret this as "drift detected, need full re-clone." This could trigger unnecessary full clones on transient DB errors.

```typescript
// reconcile.ts:119-122
} catch (error) {
  counts[resourceName] = 0;  // logger is in scope but not used
}

// reconcile.ts:161-164
} catch (error) {
  joinCounts[joinStoreKey] = 0;  // same
}
```

---

### H-04: `idempotency-db.ts` — `set()` swallows ALL errors, not just duplicate keys

- **File**: `datafn/server/src/execution/idempotency-db.ts:85-88`
- **Category**: SWALLOW + NO-LOGGER
- **Impact**: The comment says "duplicate key errors are expected on replay" but the catch block catches ALL errors — connection failures, schema errors, permission errors. If the idempotency store silently fails, mutations may be replayed without deduplication, causing duplicate data.

```typescript
// idempotency-db.ts:85-88
} catch (error) {
  // Silently fail - idempotency is best-effort
  // Duplicate key errors are expected on replay
}
```

---

### H-05: `ChangeTrackingService.getLatestServerSeq()` — returns `0` on DB error

- **File**: `datafn/server/src/execution/sync/change-tracking.ts:389-396`
- **Category**: RETURN-ZERO
- **Impact**: Used by clone and pull to determine cursors. On DB error, returns 0 instead of throwing — caller sets cursor to "0", potentially causing the client to re-fetch all data or miss changes.

```typescript
// change-tracking.ts:389-396
} catch (error) {
  this.logger?.error("Failed to get latest serverSeq", { ... });
  return 0;  // ← caller cannot distinguish "no changes" from "DB error"
}
```

---

### H-06: `DatabaseSequenceStore.getCurrent()` — returns `0` on DB error

- **File**: `datafn/server/src/execution/sync/sequence-store.ts:243-250`
- **Category**: RETURN-ZERO
- **Impact**: Same pattern as H-05. Returns 0 on DB failure. Callers assume sequence is at 0 (start), which could cause sequence collisions or incorrect sync cursors.

```typescript
// sequence-store.ts:243-250
} catch (error) {
  this.logger?.error("Failed to get current serverSeq", { ... });
  return 0;  // ← masks DB failure
}
```

---

### H-07: `executeMutationCore` outer catch — no logging

- **File**: `datafn/server/src/execution/mutation/execute.ts:183-185`
- **Category**: SWALLOW
- **Impact**: The outer fallback catch block (wrapping all `switch` cases) has no logging at all. If an unexpected error type reaches this point, it's silently converted to `{ code: "INTERNAL", message: error?.message || "Internal error" }` with no server-side log.

```typescript
// execute.ts:183-185
} catch (error: any) {
  opResult = { ok: false, code: "INTERNAL", message: error?.message || "Internal error", path: "$" };
  // ← no logger?.error() call
}
```

---

## MEDIUM Findings

### M-01: Generic `"Internal error"` returned to client across all route handlers

Every route handler catches top-level errors and returns a generic message. While the error IS logged server-side (when logger is available), the client has no actionable information.

| Route | File:Line | Logged? | Client Message |
|-------|-----------|---------|---------------|
| `/datafn/mutation` | `mutation.ts:188-194` | Yes | `"Internal error"` |
| `/datafn/query` | `query.ts:1006-1017` | Yes | `"Internal error"` |
| `/datafn/clone` | `sync.ts:111-117` | Yes | `"Internal error"` |
| `/datafn/pull` | `sync.ts:214-220` | Yes | `"Internal error"` |
| `/datafn/push` | `sync.ts:410-416` | Yes | `"Internal error"` |
| `/datafn/reconcile` | `sync.ts:511-517` | Yes | `"Internal error"` |
| `/datafn/transact` | `transact.ts:206-212` | Yes | `"Internal error"` |

**Note**: This is likely intentional for security (not leaking internal details). However, consider returning a request ID or error correlation ID so users can reference specific errors when reporting issues.

---

### M-02: Push inner catch blocks — logged but generic to client

- **File**: `datafn/server/src/execution/sync/push.ts`
- **Lines**: 260-269 (merge), 296-305 (replace), 377-386 (outer catch)
- **Category**: GENERIC-MSG
- **Impact**: Errors are logged with `logger?.error(...)` but the client always gets `"Internal error"`. The actual database error message (e.g., NOT NULL violation, constraint errors) is discarded from the client response.

---

### M-03: `recordChangeWithRetry` — retry loop with no logging

- **File**: `datafn/server/src/execution/sync/push.ts:34-42`
- **Category**: SWALLOW + NO-LOGGER
- **Impact**: Retries change tracking up to 2 times with exponential backoff, but intermediate failures are completely silent. Only the final failure throws (which may be caught above). No logger parameter available.

```typescript
// push.ts:34-42
} catch (e) {
  if (i === maxRetries) throw e;
  await new Promise(r => setTimeout(r, 50 * (i + 1)));
  // ← intermediate failures not logged
}
```

---

### M-04: `executeTransaction` — DB-level errors not logged (when `logger` is undefined)

- **File**: `datafn/server/src/execution/transact.ts:127-161`
- **Category**: SWALLOW (conditional)
- **Impact**: The transaction's DB-level error catch block (line 149-160) returns a generic `INTERNAL` error with `message: "Transaction failed: {msg}"`. No logging occurs because the function's `logger` parameter is never passed from the route handler (see C-02). The sequential execution branch (line 201-215) does log errors — but only if `logger` is defined.

---

### M-05: WebSocket `handleMessage` — bare catch discards all errors

- **File**: `datafn/server/src/ws.ts:188-190`
- **Category**: SWALLOW
- **Impact**: Not just JSON parse errors — any exception thrown during message handling is silently swallowed. Low severity since the only current action is checking for `"hello"` messages.

```typescript
// ws.ts:188-190
} catch {
  // Ignore invalid JSON/messages
}
```

---

### M-06: WebSocket heartbeat ping — no logging on failure

- **File**: `datafn/server/src/ws.ts:101-106`
- **Category**: SWALLOW
- **Impact**: Connection cleanup happens correctly, but failed pings are not logged, making it hard to diagnose connection issues.

---

### M-07: HTTP middleware `readBodyWithLimit` — error swallowed without logging

- **File**: `datafn/server/src/http/middleware.ts:52-61`
- **Category**: SWALLOW + NO-LOGGER
- **Impact**: If `req.text()` throws (streaming error, connection reset, OOM), the error is caught and a generic 400 response is returned. No logging occurs and no logger is available.

---

### M-08: `server.ts` rate limit key extractor — namespace provider errors swallowed

- **File**: `datafn/server/src/server.ts:362-369`
- **Category**: SWALLOW
- **Impact**: If `namespaceProvider.getNamespace()` throws, the error is silently caught and the user is rate-limited as `"anonymous"`. No logging — a broken namespace provider would be invisible.

```typescript
// server.ts:362-369
const defaultKeyExtractor = async (ctx: TContext): Promise<string> => {
  if (config.namespaceProvider) {
    try {
      return await config.namespaceProvider.getNamespace(ctx);
    } catch { /* fall through */ }
  }
  return "anonymous";
};
```

---

## LOW Findings

### L-01: `idempotency-db.ts:44-46` — JSON.parse catch too broad

- **File**: `datafn/server/src/execution/idempotency-db.ts:44-46`
- Comment says "malformed JSON" but catches all errors from `JSON.parse()`.

### L-02: WebSocket `close()` — client close errors swallowed

- **File**: `datafn/server/src/ws.ts:228-230`
- Expected during shutdown; low severity.

### L-03: Sequence store CAS retry — intermediate failures not logged

- **File**: `datafn/server/src/execution/sync/sequence-store.ts:188-190, 209-211`
- Only the final failure after max retries is logged.

### L-04: Change tracking CAS retry — intermediate failures not logged

- **File**: `datafn/server/src/execution/sync/change-tracking.ts:157-168`
- Same pattern as L-03.

---

## Summary Statistics

| Severity | Count | Description |
|----------|-------|-------------|
| **CRITICAL** | 5 | Logger not passed to execution functions or functions lack logger entirely |
| **HIGH** | 7 | Silent catch blocks that mask DB errors as empty data |
| **MEDIUM** | 8 | Generic messages, retry loops without logging, conditional logging gaps |
| **LOW** | 4 | Expected-case error swallowing, minor logging gaps |
| **Total** | **24** | |

### By Category

| Category | Count |
|----------|-------|
| SWALLOW (no logging at all) | 12 |
| NO-LOGGER (function lacks parameter) | 4 |
| LOGGER-NOT-PASSED (caller doesn't pass it) | 3 |
| GENERIC-MSG (logged but client gets generic) | 8 |
| RETURN-ZERO (error → 0 instead of throw) | 2 |

---

## Recommended Fix Priority

### Immediate (blocks observability for existing features)

1. **C-01**: Pass `logger` to `executeMutation()` in `mutation.ts:143`
2. **C-02**: Pass `logger` to `executeTransaction()` in `transact.ts:193`
3. **C-03**: Pass `logger` to `executeReconcile()` in `sync.ts:485`

### High (data integrity / debugging blind spots)

4. **C-04**: Add `logger` parameter to `executeClone()` and log errors in all 5 catch blocks
5. **C-05**: Add `logger` parameter to `createRestRoutes()` and log errors in all 4 REST handlers
6. **H-01**: Add `logger` parameter to `DbDataStore.create()` and `forPushdownResult()`, log in 12+ catch blocks
7. **H-04**: In `idempotency-db.ts:set()`, distinguish duplicate key errors from other errors; log non-duplicate errors at warn level
8. **H-07**: Add `logger?.error()` to the outer catch in `execute.ts:183-185`

### Medium (improved diagnostics)

9. **H-05, H-06**: Consider propagating errors instead of returning 0 in `getLatestServerSeq()` and `getCurrent()`
10. **M-03**: Add `logger` parameter to `recordChangeWithRetry()` and log retries
11. **M-08**: Log namespace provider failures at warn level in `server.ts:366`
12. **H-02, H-03**: Add logging to all clone and reconcile catch blocks once C-04/C-03 are fixed

---

## Related Issues

- `2026-03-03-r4k7m9x3-issue.md` — Original issue that triggered this audit (push merge upsert + missing logger)
- `2026-03-01-n4k8v2m7-issue.md` — KV upsert conflictTarget mismatch (same error-swallowing class)
