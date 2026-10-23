# Issue Completion Report: KV signal refresh after pull routes to remote server

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-03-02T18:05:00Z |
| **Agent** | claude-4.6-sonnet-medium-thinking |
| **Model** | claude-4.6-sonnet-medium-thinking |
| **Launcher** | Cursor |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | Darwin 25.3.0 / zsh |
| **Branch** | `next` |
| **Commit** | `664f92c` (dirty) |
| **Issue File** | `datafn/.conduct/issues/2026-03-02-k7m4x9r8-issue.md` |

---

## Issue Summary

KV signals in the datafn client incorrectly routed queries to the remote server after every pull instead of executing locally. The built-in `kv` resource (auto-injected by `ensureBuiltinKv()`) was never included in the hydration plan clone phase when users specified `hydration.bootResources`. This left the kv resource's hydration state at `"notStarted"` permanently, causing the query router to fall back to the remote for every KV query. Two redundant HTTP `/query` calls were observed on every pull cycle.

Three root causes were identified and fixed:
- **RC-1**: `initializeWithHydrationPlan()` only clones resources explicitly listed in the user's hydration plan, excluding the built-in `kv` resource.
- **RC-3**: `querySignal.ts` signal event listener broadcast-refreshed all signals when `affectedResources` was empty, causing KV signals to refresh on no-op pulls.
- **RC-4**: `applyCloneResult()` only transitions a resource to `"ready"` if the server returns records for it; resources omitted from the server response stay stuck at `"hydrating"`.

---

## Status: PASS

---

## Requirements Summary

| Requirement | Status | Evidence |
|---|---|---|
| KV hydration state reaches "ready" after clone with hydration plan | PASS | `TV-KV-001` passes: `storage.getHydrationState("kv")` returns `"ready"` |
| Resource with zero server records transitions to "ready" after clone | PASS | `TV-KV-002` passes: kv absent from server response still becomes `"ready"` |
| `sync_applied` with empty resources does NOT refresh unrelated signals | PASS | `TV-SIG-003` passes: query count unchanged after no-op pull |
| `sync_applied` with matching resources still refreshes signals | PASS | `TV-SIG-003N` passes: query count increases after pull with `resources: ["node"]` |
| All existing tests remain green | PASS | 497 tests pass across 49 test files |

---

## Implementation Summary

### Files Changed

| File | Change |
|---|---|
| `datafn/client/src/sync/engine.ts` | Fix RC-1 in `initializeWithHydrationPlan()` + Fix RC-4 in `cloneResources()` |
| `datafn/client/src/signals/querySignal.ts` | Fix RC-3: remove `length === 0` broadcast-refresh guard |
| `datafn/client/__tests__/sync.test.ts` | Add `TV-KV-001` and `TV-KV-002` tests |
| `datafn/client/__tests__/signal-invalidation.test.ts` | Add `TV-SIG-003` and `TV-SIG-003N` tests |

### Key Changes

**Fix 1 (RC-1) — `engine.ts` `initializeWithHydrationPlan()`:**

Added logic to compute the set of schema resources not listed in either `bootResources` or `backgroundResources` and not `isRemoteOnly`. These "unplanned" resources (including the built-in `kv`) are merged into the effective boot resources before the clone/hydration logic runs. This ensures framework-injected resources like `kv` are always hydrated regardless of what the user specified in the hydration plan.

**Fix 2 (RC-4) — `engine.ts` `cloneResources()`:**

After `applyCloneResult()` and the paginated clone path, added a loop that forces any requested table still not at `"ready"` to `"ready"`. This handles the case where the server returns no records for a resource (the resource is simply empty, not broken) — `applyCloneResult` only marks resources `"ready"` when they appear in the response data.

**Fix 3 (RC-3) — `querySignal.ts` `sync_applied` event listener:**

Removed the `affectedResources.length === 0` guard that caused a broadcast-refresh to all signals on every pull returning zero changed records. Now signals only refresh when `affectedResources.some(r => footprint.has(r))`, meaning only when data that affects the signal's queried resources actually changed.

---

## Verification Summary

### Test Execution

```
$ npx vitest run --reporter=verbose __tests__/sync.test.ts __tests__/signal-invalidation.test.ts

 ✓ TV-KV-001: Unplanned schema resources are cloned and reach ready state when hydration plan is used
 ✓ TV-KV-002: Resource with zero server records transitions to ready after clone
 ✓ TV-SIG-003: sync_applied with empty resources does not refresh unrelated signals
 ✓ TV-SIG-003N: sync_applied with matching resources still refreshes the signal
 Test Files  2 passed (2)
      Tests  38 passed (38)

$ npx vitest run
 Test Files  49 passed (49)
      Tests  497 passed (497)
```

### Manual Verification

The fix aligns with the issue's described expected behavior: KV queries after a pull should execute locally against IndexedDB (hydration state `"ready"`) rather than hitting the remote server. The four pre-existing tests verifying the hydration plan path (`TV-SYNC-002`, `TV-SYNC-002N`) continue to pass unchanged.

---

## Notes

- The `effectiveBootResources` approach is intentionally generic — any future framework-injected resource (not just `kv`) will be auto-included without additional changes.
- The `bootNeedingClone.length === 0` pull condition was updated to reference `effectiveBootResources` instead of the original `bootResources` so that apps with only unplanned resources (e.g. only `kv` in schema, no user boot resources) still trigger a pull on already-hydrated restarts.
- The `applyCloneResult` function is not modified — the defensive "ensure ready" loop in `cloneResources()` is the correct layer for RC-4, since `applyCloneResult` is also called from `cloneTablePaginated` and its semantics should remain focused on applying what the server returned.
- The `length === 0` removal (RC-3) is safe because: (1) clone events always emit the exact resources cloned, never an empty array; (2) the first pull after a clone with zero new records is already handled because the clone's `sync_applied` already refreshed signals; (3) the only scenario where empty resources was useful was as a safety net that masked the real bug (RC-1).
