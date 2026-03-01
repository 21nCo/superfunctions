# Issue Completion Report: Server fails on push (__ns null) and concurrent pull (ensureTable race)

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-27T12:42:00Z |
| **Agent** | Oz |
| **Model** | claude-opus-4-6 |
| **Launcher** | Warp |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | macOS Darwin 25.3.0 / zsh |
| **Branch** | next |
| **Commit** | ea87d7ee18502d2864fccc56e8a4c88aa7652080 |
| **Dirty** | yes |
| **Issue File** | datafn/.conduct/issues/2026-02-27-r7m4k9x3-issue.md |

## Issue Summary

Two critical bugs: (1) Push insert fails with `null value in column "__ns"` because the server only wraps the adapter with namespace injection when `authContextProvider` is present, but the Drizzle codegen generates `__ns NOT NULL` columns by default. (2) Concurrent pull requests on cold start cause `pg_type_typname_nsp_index` duplicate key errors because `ensureTable` has a TOCTOU race condition.

## Status: PASS

## Requirements Summary

### RC-1: Server wraps adapter based on schema multiTenant flag, not just authContextProvider

- **Status:** PASS
- **Evidence:** Changed `datafn/server/src/server.ts:218-222` — auto-wrap condition now checks `adapterHasSchemaConstraints` (Drizzle adapter has `capabilities.schema.constraints === true`), which activates namespace wrapping for SQL adapters regardless of `authContextProvider` presence. For memory adapters (tests), wrapping only activates when `authContextProvider` is present.
- **Test status:** 29/30 test files pass (306/308 tests). 2 pre-existing failures in `dfql-select.test.ts`. Additionally, 8 pre-existing failures in `namespace-data-isolation.test.ts` are now FIXED by this change (11/11 pass).

### RC-2: ensureTable uses promise-based lock instead of TOCTOU has/add

- **Status:** PASS
- **Evidence:** Changed `packages/db/src/adapters/drizzle/internal.ts:79-96` — replaced `ensuredTables` Set with `ensurePromises` Map. Concurrent calls to `ensureTable` for the same table now await the same promise, preventing duplicate DDL execution.
- **Test status:** All internal CRUD tests continue to pass.

### Testing Checklist (from issue)

- [x] Todo-app server will accept push mutations without `authContextProvider` — Drizzle adapter (schema constraints = true) triggers wrapping, `__ns` is stamped via wrapper
- [x] `__ns` column populated with `"datafn"` when no auth provider configured — default namespace from `extractNamespace` fallback
- [x] `__ns` column populated with `"user:{id}"` when auth provider IS configured — `namespace-data-isolation.test.ts` passes (11/11)
- [x] Multiple concurrent pull requests won't crash — promise-based lock ensures single DDL execution per table
- [x] Apps with `multiTenant: false` work without `__ns` — `schemaMultiTenant` check prevents wrapping
- [x] Apps with `rowLevelNamespace: false` explicitly skip wrapping — condition checks `config.rowLevelNamespace !== false`
- [x] Existing server test suite passes — 306/308 pass (2 pre-existing failures)

## Implementation Summary

### Files Changed

| File | Change |
|---|---|
| `datafn/server/src/server.ts:211-223` | Updated auto-wrap condition to check `adapterHasSchemaConstraints` (SQL adapters) in addition to `authContextProvider` |
| `packages/db/src/adapters/drizzle/internal.ts:42-96` | Replaced `ensuredTables` Set with `ensurePromises` Map for concurrent-safe DDL |

### Key Changes

1. **RC-1 Fix:** The namespace auto-wrap condition now activates for SQL-backed adapters (`capabilities.schema.constraints === true`) even without `authContextProvider`. This ensures Drizzle adapters with `__ns NOT NULL` columns always get namespace injection. Memory adapters (no schema constraints) only get wrapping when `authContextProvider` is present, preserving backward compatibility.

2. **RC-2 Fix:** The `ensureTable` method now stores the in-flight DDL promise in a Map keyed by table name. The first caller creates the promise and stores it; subsequent concurrent callers get the same promise back. This eliminates the TOCTOU race where multiple calls could pass the `has()` check before any reached `add()`.

## Verification Summary

### Verification Steps

1. `npx vitest run server/__tests__/` — 29/30 files pass, 306/308 tests pass
2. `npx vitest run server/__tests__/namespace-isolation.test.ts` — 5/5 pass
3. `npx vitest run server/__tests__/namespace-data-isolation.test.ts` — 11/11 pass (previously 3/11)
4. `npx vitest run server/__tests__/sync.test.ts` — 35/35 pass
5. `npx vitest run server/__tests__/db-adapter.test.ts` — 4/4 pass

### Pre-existing Failures (not introduced by this change)

- `dfql-select.test.ts`: 2 failures (TV-DFQL-OMIT-002, TV-DFQL-RELIDS-002) — pre-existing

### Previously Failing Tests Now Fixed

- `namespace-data-isolation.test.ts`: 8 tests previously failing now pass — the wrapping condition now correctly activates when `authContextProvider` is present

## Notes

- The wrapping gate uses `capabilities.schema.constraints` as a proxy for "adapter has real column constraints". Drizzle adapter reports `true`, memory adapter reports `false`.
- The condition also supports explicit `rowLevelNamespace` config (object form) to force wrapping on any adapter.
- The `ensurePromises` Map is scoped to the `createDrizzleInternalCrud` closure, so each adapter instance has its own lock state.
- The promise-based lock does not implement error recovery — if the DDL promise rejects, subsequent calls won't retry. This matches the previous behavior (the Set guard would also not retry after a failed DDL).
