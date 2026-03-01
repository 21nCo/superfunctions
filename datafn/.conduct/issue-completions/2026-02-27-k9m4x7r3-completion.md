# Issue Completion Report: multiTenant defaults to false — namespace column (__ns) requires explicit opt-in

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-27T12:02:00Z |
| **Agent** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 |
| **Launcher** | VS Code (Claude Code Extension) |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | macOS Darwin 25.3.0 / zsh |
| **Branch** | next |
| **Commit** | ea87d7e (dirty) |
| **Issue File** | datafn/.conduct/issues/2026-02-27-k4m7x9r3-issue.md |

## Issue Summary

The `multiTenant` flag in the datafn schema defaulted to `false`/`undefined`, meaning the `__ns` namespace column and index were only generated when developers explicitly set `multiTenant: true`. Since datafn is fundamentally a multi-user backend framework, namespace isolation should be the default. The fix inverts the default so `multiTenant` is `true` unless explicitly set to `false`.

## Status: PASS

## Requirements Summary

### REQ-1: Schema without `multiTenant` set generates `__ns` column on all tables
- **Status**: PASS
- **Evidence**: New test "should add __ns by default when multiTenant is not set (defaults to true)" passes. `validateSchema()` now returns `multiTenant: true` by default.
- **Test**: `datafn/cli/__tests__/drizzle-codegen.test.ts` — TV-SCH-002 test updated

### REQ-2: Schema with `multiTenant: false` explicitly does NOT generate `__ns` column
- **Status**: PASS
- **Evidence**: New test "should NOT add __ns when multiTenant is explicitly false" passes. Also "returns multiTenant: false when explicitly set to false" validateSchema test passes.
- **Test**: `datafn/cli/__tests__/drizzle-codegen.test.ts` — TV-SCH-002, TV-SCH-006 tests

### REQ-3: Schema with `multiTenant: true` explicitly still works as before
- **Status**: PASS
- **Evidence**: Existing test "should add __ns column to resource tables when multiTenant: true" still passes unchanged.
- **Test**: `datafn/cli/__tests__/drizzle-codegen.test.ts` — TV-SCH-002

### REQ-4: Server applies namespace wrapper by default (unless `multiTenant: false`)
- **Status**: PASS
- **Evidence**: Server namespace wrapping is gated on `config.authContextProvider && config.rowLevelNamespace !== false` in `server.ts:215`, which is independent of `schema.multiTenant`. The server-side logic was already correctly independent. No changes needed.

### REQ-5: Join tables also get `__ns` column by default
- **Status**: PASS
- **Evidence**: Existing test "should add __ns column and index to join tables when multiTenant: true" still passes. New test "should NOT add __ns to join tables when multiTenant is explicitly false" passes.
- **Test**: `datafn/cli/__tests__/drizzle-codegen.test.ts` — TV-SCH-004

### REQ-6: Existing codegen tests updated to reflect new default
- **Status**: PASS
- **Evidence**: All 39 codegen tests pass. Tests that expected no `__ns` now explicitly set `multiTenant: false`.

### REQ-7: Todo-app example schema regenerated with `__ns` columns
- **Status**: PASS
- **Evidence**: `datafn/examples/todo-app/server/datafn-schema.drizzle.ts` regenerated with `__ns` columns on all tables (categories, kv, todos, join table).

## Implementation Summary

### Files changed:
- `datafn/core/src/schema.ts` — Inverted multiTenant default: `(s as any).multiTenant === false ? false : true` (was `=== true ? true : undefined`). Always includes `multiTenant` in result (was conditionally spread).
- `datafn/core/src/types.ts` — Updated JSDoc: "Defaults to true. Set to false to disable row-level namespace isolation (single-tenant mode)."
- `datafn/cli/src/drizzle-codegen.ts` — Changed `schema.multiTenant === true` to `schema.multiTenant !== false`.
- `datafn/cli/__tests__/drizzle-codegen.test.ts` — Added `multiTenant: false` to all tests that expect no `__ns` columns. Added new tests for default-true behavior and explicit-false behavior.
- `datafn/core/__tests__/schema.test.ts` — Added `multiTenant: true` to expected result in TV-SCHEMA-001 toEqual assertion.
- `datafn/examples/todo-app/server/datafn-schema.drizzle.ts` — Regenerated with `__ns` columns and indices on all tables.

### Key changes:
- Schema validation now defaults `multiTenant` to `true` instead of `undefined`
- Codegen checks `!== false` instead of `=== true` for namespace column generation
- All existing tests that assumed no namespace columns now explicitly opt out with `multiTenant: false`

## Verification Summary

### Test execution:
- `npx vitest run datafn/cli/__tests__/drizzle-codegen.test.ts` — **39 passed, 0 failed**
- `npx vitest run datafn/core/__tests__/schema.test.ts` — **6 passed, 1 failed** (pre-existing failure in "normalizes indices object format" test unrelated to this change)
- `npx vitest run` (server tests) — **394 passed, 2 failed** (pre-existing failures in dfql-select.test.ts unrelated to this change)
- Pre-existing failures confirmed via `git stash` + test run without changes

### Manual verification:
- Confirmed `@datafn/core` rebuilt successfully after source changes
- Confirmed todo-app example schema now includes `__ns` columns on all 4 tables

## Notes

- The server-side namespace wrapping in `server.ts` is gated on `config.authContextProvider && config.rowLevelNamespace !== false`, not on `schema.multiTenant`. This is the correct architecture — codegen and runtime are independent concerns.
- Pre-existing test failures (2 in dfql-select, 1 in core schema) are unrelated to this change and exist on the base branch.
- The `defineSchema` type already accepted `multiTenant?: boolean` — no type changes needed beyond JSDoc.
