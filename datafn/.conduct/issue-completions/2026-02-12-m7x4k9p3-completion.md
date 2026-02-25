# Issue Completion Report: IndexedDbStorageAdapter "Store not found" on mutation

## Metadata

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-02-12T22:10:00Z |
| **Agent Name** | unknown-agent |
| **Model** | Claude 4.6 Opus (high thinking) |
| **Launcher** | Cursor |
| **Workspace Path** | /Users/ar/dev/superfunctions |
| **OS / Shell** | darwin 25.0.0 / zsh |
| **Git Branch** | `next` |
| **Git Commit** | `2d1a0bf847258ca5811d604fc481aa59bd0e31a0` |
| **Git Dirty** | Yes |
| **Issue File** | `datafn/.conduct/issues/2026-02-12-k7x3m9p2-issue.md` |

## Issue Summary

The todo-app example crashed with `Store not found: todos` on any mutation because `IndexedDbStorageAdapter` was constructed without the schema, causing `onupgradeneeded` to skip creating per-resource IndexedDB object stores. This was a critical bug making the entire offline/local-first mutation path non-functional.

## Status: PASS

## Requirements Addressed

### Requirement 1: Fix example app to pass schema to adapter (Fix 1)
- **Status**: PASS
- **Evidence**: Updated `datafn/examples/todo-app/client/src/lib/datafn.ts` line 140 to use `IndexedDbStorageAdapter.create({ dbName: "todo-app-db", schema })`.

### Requirement 2: Add static factory `IndexedDbStorageAdapter.create()` (Fix 2)
- **Status**: PASS
- **Evidence**: Added `static create(options: { dbName: string; schema: DatafnSchema })` method to `IndexedDbStorageAdapter`. Test `creates all resource stores and join stores from schema` passes. Test `healthCheck passes for factory-created adapter` passes.

### Requirement 3: Safety net validation in `createDatafnClient` (Fix 3)
- **Status**: PASS
- **Evidence**: Added `storageValidationPromise` that probes each resource store with `getRecord()` on client creation. When stores are missing, throws a clear `DFQL_INVALID` error: `Storage is missing object store for resource "X". Pass schema when creating IndexedDbStorageAdapter: IndexedDbStorageAdapter.create({ dbName, schema })`. Test `throws clear error when storage is missing resource stores` passes.

### Requirement 4: Handle stale databases with version-bump reopen (Fix 4)
- **Status**: PASS
- **Evidence**: Added `ensureStores()` method that checks for missing resource and join stores after initial DB open. If stores are missing, closes the database and reopens with `db.version + 1` to trigger `onupgradeneeded`. Test `creates missing stores when reopening stale DB with schema` passes. Test `preserves existing data when bumping version for missing stores` passes.

### Requirement 5: Update `createForUser` documentation (Fix 5)
- **Status**: PASS
- **Evidence**: Updated JSDoc for `createForUser` to show schema usage in examples.

## Test Status

### Test Execution

```
 Test Files  41 passed (41)
      Tests  385 passed (385)
   Duration  3.51s
```

### New Tests Added (in `__tests__/storage-idb.test.ts`)

| Test | Status |
|------|--------|
| `creates all resource stores and join stores from schema` | PASS |
| `healthCheck passes for factory-created adapter` | PASS |
| `creates missing stores when reopening stale DB with schema` | PASS |
| `preserves existing data when bumping version for missing stores` | PASS |
| `throws clear error when storage is missing resource stores` | PASS |

### Existing Tests (no regressions)

All 380 pre-existing tests pass without modification.

## Implementation Summary

### Files Changed

| File | Change |
|------|--------|
| `datafn/client/src/adapters/indexedDbStorage.ts` | Added `static create()` factory, refactored constructor to use `openDatabase()` + `ensureStores()`, added stale DB version-bump logic |
| `datafn/client/src/client.ts` | Added `storageValidationPromise` that probes resource stores on init; reordered so `localOnlyInitPromise` awaits validation first; added `.catch(() => {})` to suppress unhandled rejections on eagerly-evaluated promises |
| `datafn/examples/todo-app/client/src/lib/datafn.ts` | Changed `new IndexedDbStorageAdapter("todo-app-db")` to `IndexedDbStorageAdapter.create({ dbName: "todo-app-db", schema })` |
| `datafn/client/__tests__/storage-idb.test.ts` | Added 5 new tests covering factory method, stale DB handling, and storage validation safety net |

### Key Changes

1. **`IndexedDbStorageAdapter.create()`**: New static factory that requires `{ dbName, schema }`. Extracts resource names from schema and delegates to constructor. This is now the recommended way to create the adapter.

2. **`openDatabase()` + `ensureStores()`**: Refactored constructor to extract DB opening into a reusable `openDatabase(version)` method. After initial open, `ensureStores()` checks if all schema resource stores and join stores exist. If any are missing (stale DB from prior run without schema), it closes the DB and reopens with `version + 1`, triggering `onupgradeneeded` which creates the missing stores.

3. **`storageValidationPromise` in `createDatafnClient`**: Probes each schema resource with a lightweight `getRecord()` call. Catches "Store not found" errors and re-throws as `DFQL_INVALID` with a clear, actionable message. Defined before `localOnlyInitPromise` and awaited in `mutate()`/`query()`.

4. **Promise rejection handling**: Both `storageValidationPromise` and `localOnlyInitPromise` have `.catch(() => {})` suppressors to prevent unhandled rejection warnings. The errors are properly re-thrown when awaited in `mutate()` or `query()`.

## Verification Summary

- `npx vitest run __tests__/storage-idb.test.ts` — 8/8 tests pass (5 new + 3 existing)
- `npx vitest run` — 385/385 tests pass across 41 test files, zero regressions
- No unhandled errors or warnings in test output

## Notes

- The example app's TypeScript lint shows a temporary error on `IndexedDbStorageAdapter.create()` because the example imports from `@datafn/client` which resolves to `dist/` (compiled output not yet rebuilt). This resolves after `npm run build` in `datafn/client/`.
- The raw constructor `new IndexedDbStorageAdapter(dbName, resources?, schema?)` is preserved for backward compatibility. Existing code that already passes schema continues to work unchanged.
- `createForUser()` signature is unchanged (backward compatible); only JSDoc was updated to recommend passing schema.
- The `ensureStores()` approach handles the stale DB edge case transparently — no manual IndexedDB deletion needed by end users.
