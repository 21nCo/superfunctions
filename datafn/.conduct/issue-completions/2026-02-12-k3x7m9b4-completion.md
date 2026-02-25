# Issue Completion Report: SYNC-CURSOR-001 — Global Cursor Support

## Metadata

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-02-12T22:00:00Z |
| **Agent Name** | factory-droid[bot] |
| **Model** | Claude Sonnet 4.5 |
| **Launcher** | Factory Droid |
| **Workspace Path** | /Users/ar/dev/superfunctions |
| **OS / Shell** | darwin 25.0.0 / zsh |
| **Git Branch** | heads/next |
| **Git Commit** | 2d1a0bf |
| **Git Status** | Dirty (datafn client changes + issue files) |
| **Issue File Path** | datafn/.conduct/issues/2026-02-12-b3k9m2x7-issue.md |

## Issue Summary

Sync failed at startup with `Error: Unknown table: __global_cursor__` when using the schema-based IndexedDB storage adapter (`IndexedDbStorageAdapter.create({ schema })`). The adapter's `getCursor` and `setCursor` methods validated all cursor keys as table names via `validateTableName()`, rejecting the internal `__global_cursor__` key used by the sync engine. This was a high-severity bug blocking sync for any app using the recommended schema-based adapter creation pattern.

## Status

**PASS** — All requirements met, all tests passing, fix verified in both adapters and unit tests.

## Requirements Summary

### Requirements Addressed

1. **Allow `__global_cursor__` in getCursor/setCursor when using schema-based adapter**
   - Status: PASS
   - Evidence: 
     - Modified `indexedDbStorage.ts` lines 588-594 and 598-610 to skip validation for `__global_cursor__`
     - Added unit test `IndexedDbStorageAdapter — global cursor support (SYNC-CURSOR-001)` with 3 test cases
     - Test verifies: `getCursor("__global_cursor__")` and `setCursor("__global_cursor__", "0")` work without throwing
   - Test status: PASS — `storage-idb.test.ts` tests pass (11 tests total, including 3 new global cursor tests)

2. **Preserve table-name validation for actual resource names**
   - Status: PASS
   - Evidence:
     - Validation still enforced for non-internal cursor keys
     - Added test case verifying unknown table names still throw: `getCursor("unknown_table")` rejects with "Unknown table: unknown_table"
   - Test status: PASS — Test "still validates actual resource names when using schema-based creation" passes

3. **Apply same fix to memoryStorage.ts for consistency**
   - Status: PASS
   - Evidence:
     - Modified `memoryStorage.ts` lines 228-232 and 234-244 with identical skip-validation logic
     - Both adapters now have consistent behavior for internal cursor keys
   - Test status: PASS — All memory storage tests continue to pass

4. **Verify no regressions in existing tests**
   - Status: PASS
   - Evidence: All 404 tests across 42 test files pass
   - Test status: PASS — See test execution results below

5. **Fix enables sync to start in todo-app example**
   - Status: PASS
   - Evidence:
     - Todo-app uses `IndexedDbStorageAdapter.create({ dbName: "todo-app-db", schema })`
     - Sync engine calls `getCursor("__global_cursor__")` and `setCursor("__global_cursor__", cursor)` in `apply.ts` and `cloneUp.ts`
     - With the fix, these calls no longer throw
   - Test status: PASS — Client builds successfully, unit tests verify the fix

## Implementation Summary

### Files Changed/Added

**Modified:**
1. `datafn/client/src/adapters/indexedDbStorage.ts` — Skip validation for `__global_cursor__` in `getCursor` and `setCursor`
2. `datafn/client/src/adapters/memoryStorage.ts` — Same fix for consistency
3. `datafn/client/__tests__/storage-idb.test.ts` — Added 3 new test cases in describe block "IndexedDbStorageAdapter — global cursor support (SYNC-CURSOR-001)"

### Key Changes

**indexedDbStorage.ts (lines 588-610):**
```typescript
async getCursor(resource: string): Promise<string | null> {
  // Skip validation for internal cursor keys (SYNC-CURSOR-001)
  if (resource !== "__global_cursor__") {
    this.validateTableName(resource);
  }
  // ... rest of implementation
}

async setCursor(resource: string, cursor: string | null): Promise<void> {
  // Skip validation for internal cursor keys (SYNC-CURSOR-001)
  if (resource !== "__global_cursor__") {
    this.validateTableName(resource);
  }
  // ... rest of implementation
}
```

**memoryStorage.ts (lines 228-244):**
Same skip-validation logic applied to both `getCursor` and `setCursor`.

**storage-idb.test.ts:**
Added comprehensive test suite:
- ✅ Allows `getCursor` and `setCursor` for `__global_cursor__` when using schema-based creation
- ✅ Still validates actual resource names (unknown tables throw)
- ✅ Supports per-resource and global cursor operations together

## Verification Summary

### Verification Steps Executed

1. **Unit tests:**
   ```bash
   cd /Users/ar/dev/superfunctions/datafn/client && npm test
   ```
   - Result: PASS — 404 tests passed across 42 test files
   - Duration: 4.29s
   - New tests added: 3 tests for SYNC-CURSOR-001
   - All existing tests continue to pass (no regressions)

2. **Build verification:**
   ```bash
   cd /Users/ar/dev/superfunctions/datafn/client && npm run build
   ```
   - Result: PASS — Build succeeded in 2.3s
   - Output: ESM, CJS, and DTS bundles generated without errors

3. **Code review:**
   - Verified fix aligns with issue root causes
   - Confirmed consistent implementation across both adapters
   - Verified no other cursor-related validation points need updating

### Test Execution Results

**Test Summary:**
```
Test Files  42 passed (42)
     Tests  404 passed (404)
  Start at  21:55:58
  Duration  4.29s (transform 1.97s, setup 4ms, collect 7.08s, tests 4.49s, environment 5ms, prepare 3.99s)
```

**New Tests (storage-idb.test.ts):**
- ✓ allows getCursor and setCursor for __global_cursor__ when using schema-based creation
- ✓ still validates actual resource names when using schema-based creation
- ✓ allows per-resource and global cursor operations together

**No test failures or regressions detected.**

### Manual Verification

- Reviewed `datafn/examples/todo-app/client/src/lib/datafn.ts` — confirms app uses `IndexedDbStorageAdapter.create({ dbName, schema })`
- Reviewed `datafn/client/src/sync/apply.ts` — confirms sync engine uses `GLOBAL_CURSOR_KEY = "__global_cursor__"`
- Reviewed `datafn/client/src/sync/cloneUp.ts` — confirms clone logic calls `getCursor("__global_cursor__")` and `setCursor("__global_cursor__", ...)`
- With the fix, these operations succeed instead of throwing "Unknown table: __global_cursor__"

## Notes

1. **Fix is minimal and targeted**: Only modified `getCursor` and `setCursor` to skip validation for the known internal key `__global_cursor__`. No changes to validation logic for actual resource names.

2. **Consistent across adapters**: Applied identical fix to both `IndexedDbStorageAdapter` and `MemoryStorageAdapter` to maintain consistency and prevent future issues if memory adapter is used with `validResources`.

3. **No API changes**: Fix is internal to the storage adapters; no changes to public APIs or interfaces.

4. **Test coverage**: Added comprehensive test coverage for the global cursor scenario, including:
   - Positive case: `__global_cursor__` works
   - Negative case: Unknown table names still throw
   - Integration case: Per-resource and global cursors work together

5. **No TODOs or deferrals**: Implementation is complete and production-ready.

6. **Issue referenced code reference**: The fix implements the "Recommended (minimal change)" approach from the issue's "Proposed Fixes" section — skip table-name validation for `__global_cursor__` only.

7. **Sync engine compatibility**: The constant `GLOBAL_CURSOR_KEY` is defined in `apply.ts` but we used the hardcoded string `"__global_cursor__"` in the adapters to avoid coupling. If more internal cursor keys are added in the future, this could be refactored to use a shared constant or set.

8. **Performance impact**: Negligible — added one string comparison per `getCursor`/`setCursor` call when `validResources` is set.

9. **Backward compatibility**: No breaking changes. Existing code using resource names for cursors continues to work. Only adds support for the internal `__global_cursor__` key that was previously rejected.

10. **Edge cases handled**: 
    - `null` cursor values already validated by existing `validateCursor()` call
    - Resource cursor keys (e.g., "todos", "categories") still validated as table names
    - Invalid table names still throw as expected

## Blockers

None.

---

**Issue Resolution:** COMPLETE  
**All acceptance criteria met:** YES  
**Production ready:** YES
