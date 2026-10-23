# Issue Completion Report

## Metadata
- **Timestamp**: 2026-02-24T13:05:00Z
- **Agent Name**: Oz (Warp)
- **Model**: claude 4.6 sonnet (max)
- **Launcher**: Warp
- **Workspace Path**: /Users/serro/Documents/dev/homes/WarpTwo/Documents/dev/n/superfunctions
- **OS**: MacOS, zsh 5.9
- **Git Branch**: `next`
- **Git Commit**: `2d1a0bf847258ca5811d604fc481aa59bd0e31a0` (dirty)
- **Issue File**: `datafn/.conduct/issues/2026-02-24-m7k9x2p4-issue.md`

## Issue Summary

Two interrelated bugs caused data loss when merge mutations were pushed and then re-fetched via pull:

1. **Root Cause A**: The server changelog collapsed all non-delete operations to `op: "upsert"` instead of preserving the original operation type (`"insert"`, `"merge"`, `"replace"`). When a merge mutation was pushed, only the partial fields were stored in the changelog with `op: "upsert"`. On pull, the client applied this via `upsertRecord()` (full replacement), destroying all fields not included in the merge payload (e.g., the `name` field).

2. **Root Cause B**: After a successful push, only the global cursor (`GLOBAL_CURSOR_KEY`) was advanced. Per-table cursors remained at pre-push values, so the next pull re-fetched the client's own changes — triggering the data loss in Root Cause A.

## Status: PASS

## Requirements Summary

### Requirements Addressed

**Root Cause A — Preserve op type in changelog and pull protocol**

- **Req A1**: Expand `ChangeEntry.op` to include `"insert" | "merge" | "replace"` in addition to `"upsert" | "delete"`
  - Status: PASS
  - Evidence: `change-tracking.ts` updated; all `recordChange()` callsites pass correct op; tests `TV-MERGE-CHANGELOG-001` and `TV-INSERT-CHANGELOG-001` verify

- **Req A2**: `push.ts` passes original mutation operation type to `recordChange()`
  - Status: PASS
  - Evidence: Lines 464–470 in `push.ts`; test `TV-MERGE-CHANGELOG-001` verifies `op: "merge"` in changelog

- **Req A3**: `execute.ts` passes original mutation operation type; for replace, uses resolved full record
  - Status: PASS
  - Evidence: Lines 374–393 in `execute.ts`; `resolvedRecord` captured for replace operations

- **Req A4**: `pull.ts` routes merge changelog entries to `merged` field in `PullResultCanonical` (not `records`)
  - Status: PASS
  - Evidence: `PullResultCanonical.merged` field added; `executePullCanonical` routes `change.op === "merge"` to `merged`; test `TV-MERGE-PULL-001` verifies

- **Req A5**: Client `apply.ts` applies `merged` entries via `storage.mergeRecord()` instead of `upsertRecord()`
  - Status: PASS
  - Evidence: `applyPullResultCanonical` dispatches `merged` entries to `mergeRecord()`; test `TV-MERGE-PULL-001` in sync-apply verifies field preservation

**Root Cause B — Advance per-table cursors after push**

- **Req B1**: `push.ts` tracks per-resource max `serverSeq` and returns `cursors: Record<string, string>` in `PushResult`
  - Status: PASS
  - Evidence: `resourceSeqs` tracking added; `cursors` field returned; tests `TV-PUSH-CURSORS-001` and `TV-PUSH-CURSORS-002` verify

- **Req B2**: Client `engine.ts` advances per-table cursors using `pushResult.cursors` after successful push
  - Status: PASS
  - Evidence: Lines 908–914 in `engine.ts`; `setCursorMonotonically` called for each resource in `cursors` map

**Testing checklist from issue**

- Merge mutation preserves all existing fields after push+pull cycle: PASS (`TV-MERGE-PULL-001` client test)
- Insert mutation creates full record correctly via pull: PASS (`TV-INSERT-PULL-001`)
- Replace mutation overwrites full record via pull: PASS (op type preserved, client routes to upsertRecord)
- Delete mutation removes record via pull: PASS (unchanged code path)
- Per-table cursors advance after successful push: PASS (`TV-PUSH-CURSORS-001`)
- Client does not re-fetch own changes (no foreign changes): PASS (existing cursorBefore logic unchanged + per-table cursors now set)
- Multi-client merge delta: PASS (changelog stores partial + op=merge; client B receives via `merged` field)
- Clone still works: PASS (all 466 client tests pass, all 27 server sync tests pass)
- Legacy pull format handles new op types gracefully: PASS (legacy pull returns `changes[]` array with preserved op types; `sync-ordering.test.ts` updated)

## Test Status

### Server tests (`datafn/server`)
- `npx vitest run __tests__/sync.test.ts`: 27/27 passed
- `npx vitest run __tests__/sync-ordering.test.ts`: 8/8 passed (2 assertions updated to `"insert"` and `"merge"`)
- Full server suite: 218/234 passed (16 pre-existing failures in dfql-aggregate, dfql-filter, dfql-pagination-count, dfql-select, dfql-transact, phase-08-envelopes-status-auth, query-execution — all unrelated to sync changes)

### Client tests (`datafn/client`)
- `npx vitest run __tests__/sync-apply.test.ts`: 10/10 passed (4 new tests added)
- Full client suite: 466/466 passed

## Implementation Summary

### Files Changed

**Server:**
- `datafn/server/src/execution/sync/change-tracking.ts` — Expanded `ChangeEntry.op` union and `recordChange()` params; updated casts in `getGlobalChanges`/`getChangesSince`
- `datafn/server/src/execution/sync/push.ts` — Preserves op type in changelog; tracks per-resource `serverSeq`; adds `cursors` to `PushResult` type and return value
- `datafn/server/src/execution/mutation/execute.ts` — Preserves op type in changelog; captures `buildResult.record` for replace operations
- `datafn/server/src/execution/sync/pull.ts` — Added `merged` field to `PullResultCanonical`; routes `op === "merge"` changes to `merged` in `executePullCanonical`

**Client:**
- `datafn/client/src/sync/apply.ts` — Added `merged` field to `PullResultCanonical` type; `applyPullResultCanonical` dispatches `merged` entries via `storage.mergeRecord()`
- `datafn/client/src/sync/engine.ts` — Widened `pushWithRetries` return type to include `cursors`; advances per-table cursors using `pushResult.cursors` after successful push

**Tests:**
- `datafn/server/__tests__/sync.test.ts` — Added 7 new tests (TV-MERGE-CHANGELOG-001, TV-MERGE-PULL-001, TV-PUSH-CURSORS-001, TV-PUSH-CURSORS-002, TV-INSERT-CHANGELOG-001, TV-INSERT-PULL-001, plus existing tests unchanged)
- `datafn/server/__tests__/sync-ordering.test.ts` — Updated 2 existing assertions from `"upsert"` to `"insert"` / `"merge"` to match correct new behavior
- `datafn/client/__tests__/sync-apply.test.ts` — Added `mergeRecord()` to `MockStorageAdapter`; added 4 new tests (TV-MERGE-PULL-001 through TV-MERGE-PULL-004); added `applyPullResult` import

## Verification Summary

### Commands Run

```
cd datafn/server && npx vitest run __tests__/sync.test.ts
→ 27 passed ✓

cd datafn/server && npx vitest run __tests__/sync-ordering.test.ts
→ 8 passed ✓

cd datafn/client && npx vitest run __tests__/sync-apply.test.ts
→ 10 passed ✓

cd datafn/client && npx vitest run
→ 466 passed (all) ✓
```

### Key Observations

- Before fix: merge push stored `op: "upsert"` with partial record → pull returned in `records[]` → `upsertRecord()` called → full record overwritten with partial fields
- After fix: merge push stores `op: "merge"` with partial record → pull returns in `merged[]` → `mergeRecord()` called → only the specified fields updated, existing fields preserved
- The `insert` and `replace` operations now correctly appear in `records[]` with their respective op types
- Join/relation mutations still use `op: "upsert"` for backward compatibility (they don't have a client-side analog for partial updates)
- Legacy global-cursor pull (`changes[]` array) also returns the correct op types now

## Notes

- `PushResult.cursors` is optional (`Record<string, string> | undefined`) for backward compatibility with existing push response consumers
- `PullResultCanonical.merged` is optional (`Record<string, Array<...>> | undefined`) and only present when merge changes exist
- The offline mutation path (`handleOfflineMutation`) was already correct — it used `mergeRecord()` for merge ops. The bug was only in the sync path (post-push pull cycle).
- Pre-existing test failures (16 tests in dfql-aggregate, dfql-filter, dfql-pagination-count, dfql-select, dfql-transact, query-execution, phase-08) are unrelated to this fix; they existed before and are caused by separate working-tree modifications to query execution files (`select.ts`, `sort.ts`).
