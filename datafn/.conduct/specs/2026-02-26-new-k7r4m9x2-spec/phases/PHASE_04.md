# Phase 4: Schema Flag + Drizzle Codegen

## Goal
Add `multiTenant` boolean to `DatafnSchema` and update the Drizzle codegen to emit `__ns TEXT NOT NULL` column + index on every data table when enabled.

## Scope
- `datafn/core/src/schema.ts` (or wherever `DatafnSchema` is defined)
- `datafn/cli/src/drizzle-codegen.ts`

## Requirements Covered
SCH-001, SCH-002, SCH-003, SCH-004, SCH-005, SCH-006, MIG-001

## Depends On
None (parallel to Phases 1-3)

## Tasks

### 4.1 — `multiTenant` schema field
- Add `multiTenant?: boolean` to `DatafnSchema` type.
- Default: `false` (opt-in).
- When `true`, signals that the generated Drizzle schema should include `__ns` column.
- Add validation: warn if `multiTenant: true` but no `authContextProvider` is expected.

### 4.2 — Drizzle codegen: `__ns` column
In `datafn/cli/src/drizzle-codegen.ts`:
- When `schema.multiTenant === true`:
  - Add `__ns: text('__ns').notNull()` to every user-defined data table.
  - Do NOT add to internal tables (`__datafn_meta`, `__datafn_changes`).

### 4.3 — Drizzle codegen: `__ns` index
- For each data table with `__ns`, generate a composite index: `(__ns)` or `(__ns, id)` depending on access pattern.
- Index name convention: `idx_{tableName}___ns`.

### 4.4 — Codegen snapshot tests
- Add test that generates schema with `multiTenant: true` and asserts the output contains `__ns` column + index definitions.
- Add test with `multiTenant: false` and assert NO `__ns` column.

## Verification
- Codegen tests pass.
- Generated schema compiles with `tsc` without errors.
- Index definitions are syntactically valid Drizzle code.

## Estimate
~2 days

## Exit Criteria
- `multiTenant` flag accepted in schema definition.
- Codegen produces correct `__ns` column + index when enabled.
- Codegen output unchanged when disabled.
- Snapshot tests pass.
