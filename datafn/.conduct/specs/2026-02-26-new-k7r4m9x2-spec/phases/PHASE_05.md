# Phase 5: Migration Guidance + Drizzle Adapter Integration Test

## Goal
Provide migration documentation for existing databases and run an end-to-end test with the Drizzle adapter + SQLite to prove the full stack works.

## Scope
- `datafn/.conduct/specs/2026-02-26-new-k7r4m9x2-spec/MIGRATION.md` (NEW — guidance doc)
- `packages/db/src/adapters/drizzle/__tests__/namespace.test.ts` (NEW)

## Requirements Covered
MIG-001, TST-001

## Depends On
Phase 0, Phase 1, Phase 4

## Tasks

### 5.1 — Migration documentation
Create `MIGRATION.md` covering:
- **New projects**: Set `multiTenant: true` in schema, run codegen, done.
- **Existing projects (empty data)**: Add `multiTenant: true`, regenerate schema, run Drizzle migration (`drizzle-kit generate` + `drizzle-kit migrate`).
- **Existing projects (with data)**: Step-by-step:
  1. Add `__ns` column as `TEXT DEFAULT 'datafn'` (nullable initially for backfill).
  2. Backfill existing rows: `UPDATE {table} SET __ns = 'datafn' WHERE __ns IS NULL`.
  3. Alter column to `NOT NULL`.
  4. Create index.
  5. Enable `multiTenant: true` and `authContextProvider`.
- **Rollback**: Drop `__ns` column, remove index, set `multiTenant: false`.

### 5.2 — Drizzle + SQLite integration test
Create test that:
1. Sets up an in-memory SQLite database.
2. Creates a table with `__ns TEXT NOT NULL` column + index.
3. Instantiates Drizzle adapter.
4. Wraps with `wrapWithRowLevelNamespace`.
5. Runs the contract test suite from Phase 1.
6. Additionally tests:
   - SQL-level verification: raw query confirms `__ns` values are stored correctly.
   - Index is used (EXPLAIN QUERY PLAN shows index scan).

### 5.3 — Run full contract tests against Drizzle adapter
Call `runRowLevelNamespaceContractTests()` with the wrapped Drizzle adapter.

## Verification
- Drizzle + SQLite integration test passes.
- Contract tests pass against Drizzle adapter.
- Migration doc is reviewed for completeness.

## Estimate
~2 days

## Exit Criteria
- Drizzle adapter passes all contract tests when wrapped.
- Migration documentation covers new, existing-empty, and existing-with-data scenarios.
- End-to-end proof: namespace values are physically stored in SQLite and queries are isolated.
