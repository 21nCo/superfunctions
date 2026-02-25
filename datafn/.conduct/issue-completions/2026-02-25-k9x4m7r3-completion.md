# Issue Completion Report: Drizzle codegen omits UNIQUE(from, to) constraint on many-many join tables

## Metadata

| Field | Value |
|---|---|
| **Issue** | 2026-02-25-k9x4m7r3-issue.md |
| **Timestamp** | 2026-02-25T19:50:00Z |
| **Agent** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 |
| **Launcher** | VS Code (Claude Code Extension) |
| **Branch** | next |

---

## Requirements Summary

The Drizzle codegen generated join tables for many-many relations with only a PRIMARY KEY on `id` and no unique constraint on `(from, to)`. This meant any `ON CONFLICT` targeting `(from, to)` failed on PostgreSQL with error `42P10`. The schema also lacked data integrity enforcement at the database level for the foreign key pair.

### Root Causes

1. **RC-1**: `generateDrizzleSchema` in `drizzle-codegen.ts` did not emit a `uniqueIndex` on `(from, to)` for join tables
2. **RC-2**: Join tables used a flat column list without a table callback, unlike regular resources which already supported the `(table) => [...]` pattern for indices

---

## Implementation Details

### Fix A: Add `uniqueIndex(from, to)` to join table codegen (Primary Fix)

**File**: `datafn/cli/src/drizzle-codegen.ts` (lines 136-143)

- After emitting join table fields, now emits a `(table) => [...]` callback with a `uniqueIndex` on `(fromCol, toCol)`
- Adds `"uniqueIndex"` to the `usedImports` set so it appears in the import line
- Uses `camelToSnake` for the index name (e.g. `__datafn_join_todos_tags_from_to_idx`, `user_roles_user_id_role_id_idx`)
- Works identically across all three dialects (postgres, mysql, sqlite) since Drizzle's `uniqueIndex()` is exported from all dialect modules

### Fix B: Update generated example schema

**File**: `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts`

- Added `uniqueIndex` to import line
- Added `(table) => [uniqueIndex(...)]` callback to `__datafn_join_todos_tags` table definition

---

## Tests Added / Updated

### Updated: TV-DRZ-JOIN-001 (join table generation)

- Now asserts `}, (table) => [` callback is present
- Asserts `uniqueIndex("__datafn_join_todos_tags_from_to_idx").on(table.from, table.to)` is in output
- Asserts `uniqueIndex` appears in imports

### Updated: TV-DRZ-JOIN-002 (join table with metadata and custom names)

- Asserts `uniqueIndex("user_roles_user_id_role_id_idx").on(table.userId, table.roleId)` for custom column names

### Added: Edge case — uniqueIndex only covers (from, to) with metadata

- Schema with `students`/`courses` many-many with `grade` and `enrolledAt` metadata
- Asserts `uniqueIndex` is on `(from, to)` only
- Asserts `table.grade` and `table.enrolledAt` are NOT in the uniqueIndex

### Updated: Edge case — many-many without metadata

- Now also asserts `uniqueIndex` presence on the minimal join table

---

## Verification Results

| Test Suite | Result |
|---|---|
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | 27 passed |

All acceptance criteria met:
- [x] Codegen emits `uniqueIndex(from, to)` for all many-many join tables
- [x] Custom join column names produce correct index names
- [x] Metadata columns are NOT included in the unique index
- [x] Import line includes `uniqueIndex` when join tables are present
- [x] All existing codegen tests pass (no regressions)
- [x] Generated example schema updated to match new output
- [x] Works for all three dialects (postgres, mysql, sqlite)

---

## Files Modified

| File | Change |
|---|---|
| `datafn/cli/src/drizzle-codegen.ts` | Emit `uniqueIndex(from, to)` with table callback for join tables |
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | Updated JOIN-001, JOIN-002 tests; added metadata edge case test |
| `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts` | Added `uniqueIndex` import and constraint to join table |
