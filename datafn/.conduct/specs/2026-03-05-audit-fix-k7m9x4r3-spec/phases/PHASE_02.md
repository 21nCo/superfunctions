# PHASE_02: Add Logging to All Catch Blocks + Fix RETURN-ZERO Patterns

## Phase Goal

Now that all functions have `logger` available (from PHASE_00 and PHASE_01), add actual logging statements to every silent catch block identified in the audit. Also fix the two RETURN-ZERO patterns where errors are masked as numeric `0`.

## In Scope

- LOG-008: Add logging to all `executeClone` catch blocks (5 sites)
- LOG-009: Add logging to all `executeReconcile` catch blocks (2 sites)
- LOG-010 (complete): Log non-duplicate errors in `idempotency-db.ts set()`
- LOG-011 (complete): Log retries in `recordChangeWithRetry()`
- LOG-012: Log namespace provider errors in `server.ts`
- LOG-013 (complete): Log errors in `readBodyWithLimit`
- LOG-014: Add logging to all `DbDataStore` catch blocks (12+ sites)
- SEQ-001: Propagate errors in `getLatestServerSeq()` instead of returning 0
- SEQ-002: Propagate errors in `DatabaseSequenceStore.getCurrent()` instead of returning 0
- LOG-005 (complete): Add `logger?.error(...)` to all 4 REST handler catch blocks

## Out of Scope

- WebSocket logging (PHASE_03)
- CAS retry logging (PHASE_03)
- Idempotency JSON.parse narrowing (PHASE_03)

## Deliverables

| File | Change |
|------|--------|
| `datafn/server/src/execution/sync/clone.ts` | Add `logger?.warn(...)` to 5 catch blocks |
| `datafn/server/src/execution/sync/reconcile.ts` | Add `logger?.warn(...)` to 2 catch blocks |
| `datafn/server/src/execution/idempotency-db.ts` | Distinguish dup-key vs other errors in `set()` catch; log non-dup at warn |
| `datafn/server/src/execution/sync/push.ts` | Log intermediate retries in `recordChangeWithRetry()` |
| `datafn/server/src/server.ts` | Add `logger.warn(...)` to namespace provider catch in `defaultKeyExtractor` |
| `datafn/server/src/http/middleware.ts` | Add `logger?.warn(...)` to `readBodyWithLimit` catch block |
| `datafn/server/src/execution/db-store.ts` | Add `logger?.warn(...)` to all 12+ catch blocks |
| `datafn/server/src/execution/sync/change-tracking.ts` | Remove `return 0` from `getLatestServerSeq()` catch — re-throw after logging |
| `datafn/server/src/execution/sync/sequence-store.ts` | Remove `return 0` from `getCurrent()` catch — re-throw after logging |
| `datafn/server/src/routes/rest.ts` | Add `logger?.error(...)` to all 4 REST handler catch blocks |
| Callers of `getLatestServerSeq()` and `getCurrent()` | Add try-catch if not already present |

## Requirements Covered

LOG-005 (catch blocks), LOG-008, LOG-009, LOG-010, LOG-011, LOG-012, LOG-013, LOG-014, SEQ-001, SEQ-002

## Implementation Tasks

### Clone catch blocks (LOG-008)

1. [ ] `clone.ts` ~line 187-189 (table count catch): Add `logger?.warn("Clone: table count failed", { error: String(error), resource: tableName, operation: "clone-count" });` before `tableCounts[tableName] = 0`.
2. [ ] `clone.ts` ~line 226-229 (paginated data catch): Add `logger?.warn("Clone: paginated fetch failed", { error: String(error), resource: tableName, operation: "clone-paginate" });`.
3. [ ] `clone.ts` ~line 246-249 (non-paginated data catch): Add `logger?.warn("Clone: fetch failed", { error: String(error), resource: tableName, operation: "clone-fetch" });`.
4. [ ] `clone.ts` ~line 292-295 (join table catch): Add `logger?.warn("Clone: join table fetch failed", { error: String(error), operation: "clone-joins" });` before `continue`.

### Reconcile catch blocks (LOG-009)

5. [ ] `reconcile.ts` ~line 119-122 (resource count catch): Add `logger?.warn("Reconcile: resource count failed", { error: String(error), resource: resourceName, operation: "reconcile-count" });`.
6. [ ] `reconcile.ts` ~line 161-164 (join count catch): Add `logger?.warn("Reconcile: join count failed", { error: String(error), joinTable: joinStoreKey, operation: "reconcile-join-count" });`.

### Idempotency store (LOG-010)

7. [ ] `idempotency-db.ts` `set()` catch (~line 85-88): Replace empty catch with:
   ```typescript
   } catch (error: any) {
     const code = error?.code;
     const msg = (error?.message || "").toLowerCase();
     const isDuplicate =
       code === "23505" || code === "UNIQUE_VIOLATION" || code === "ER_DUP_ENTRY" ||
       code === "SQLITE_CONSTRAINT_UNIQUE" ||
       msg.includes("unique") || msg.includes("duplicate") || msg.includes("conflict");
     if (!isDuplicate) {
       this.logger?.warn("Idempotency store set failed (non-duplicate)", {
         error: String(error),
         operation: "idempotency-set",
       });
     }
   }
   ```

### Push retry logging (LOG-011)

8. [ ] `push.ts` `recordChangeWithRetry()` catch (~line 38-41): Add before the retry:
   ```typescript
   logger?.warn("Change tracking retry", { attempt: i + 1, maxRetries, error: String(e) });
   ```

### Server namespace provider logging (LOG-012)

9. [ ] `server.ts` `defaultKeyExtractor` catch (~line 366): Replace `catch { /* fall through */ }` with:
   ```typescript
   catch (error) {
     logger.warn("Namespace provider failed for rate limiting, using anonymous", {
       error: String(error),
       operation: "rate-limit-key",
     });
   }
   ```

### Middleware body read logging (LOG-013)

10. [ ] `middleware.ts` `readBodyWithLimit` catch (~line 52-61): Add before the return:
    ```typescript
    logger?.warn("Failed to read request body", { error: String(error), operation: "readBody" });
    ```
    Note: the catch block needs to capture the error variable (change `catch {` to `catch (error) {`).

### REST handler logging (LOG-005 completion)

11. [ ] `rest.ts` GET handler catch (~line 119-124): Add `logger?.error("REST GET failed", { error: String(err), resource, operation: "rest-get" });` before `return errorResponse(err)`.
12. [ ] `rest.ts` POST handler catch (~line 193-198): Same pattern with `"rest-post"`.
13. [ ] `rest.ts` PATCH handler catch (~line 267-272): Same pattern with `"rest-patch"`.
14. [ ] `rest.ts` DELETE handler catch (~line 334-339): Same pattern with `"rest-delete"`.

### DbDataStore catch blocks (LOG-014)

15. [ ] Add `logger?.warn(...)` to all catch blocks in `create()` (~line 52-54).
16. [ ] Add `logger?.warn(...)` to all catch blocks in `forPushdownResult()` (~lines 139, 154, 169, 191, 210, 242, 310, 333, 347, 364).
17. [ ] Add `logger?.warn(...)` to catch blocks in `loadJoinRows()` (~line 664-666) and secondary resource loading (~line 855-857).

### RETURN-ZERO fixes (SEQ-001, SEQ-002)

18. [ ] `change-tracking.ts` `getLatestServerSeq()` (~line 389-396): Change:
    ```typescript
    // Before:
    } catch (error) {
      this.logger?.error("Failed to get latest serverSeq", { ... });
      return 0;
    }
    // After:
    } catch (error) {
      this.logger?.error("Failed to get latest serverSeq", { ... });
      throw error;
    }
    ```
19. [ ] Audit all callers of `getLatestServerSeq()` — ensure they have try-catch. Callers in `clone.ts` and `push.ts` already have outer catch blocks. Verify no unhandled rejections.
20. [ ] `sequence-store.ts` `getCurrent()` (~line 243-250): Change `return 0` to `throw error`.
21. [ ] Audit all callers of `getCurrent()` — ensure they have try-catch.

### Test & verify

22. [ ] Run `npx vitest run datafn/server` — all tests must pass.
23. [ ] If any tests relied on `getLatestServerSeq()` returning 0 on error, update them to expect a throw.

## Verification Steps

1. `npx vitest run datafn/server` — all tests pass.
2. Grep to verify no bare `catch {` or `catch (error) { }` blocks remain in:
   - `clone.ts`
   - `reconcile.ts`
   - `db-store.ts`
   - `idempotency-db.ts`
3. Grep to verify `getLatestServerSeq` and `getCurrent` no longer have `return 0` in catch blocks.
4. TypeScript compilation check — no errors.

## Expected Outcomes

- All previously-silent catch blocks now log errors.
- `getLatestServerSeq()` and `getCurrent()` propagate errors to callers.
- Idempotency store distinguishes duplicate key errors from genuine failures.
- REST handlers, clone, reconcile, and push retry all have observable error paths.

## Stop Condition

Report: all catch blocks updated, all tests pass, grep confirms no remaining silent catches in target files.
