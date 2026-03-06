# Issue Completion Report: KV table primary key cross-tenant collision fix

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-03-01T18:58:00Z |
| **Agent Name** | unknown-agent |
| **Model** | claude-opus-4-6[1m] |
| **Launcher** | Claude Code (Warp) |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Git Branch** | next |
| **Git Commit** | 664f92c |
| **Git Dirty** | Yes |
| **Issue File** | datafn/.conduct/issues/2026-03-01-x7k3m9v4-issue.md |

## Issue Summary

The KV table (and all resource tables) used `id` as the sole primary key. In multi-tenant mode (`multiTenant: true`, the default), the `__ns` column provides row-level namespace isolation but was not part of the primary key. This caused: (1) unique constraint violations when two tenants set the same KV key, (2) cross-tenant data overwrites via upsert `ON CONFLICT (id)` that matched across tenants.

## Status: PASS

## Requirements Summary

### Requirement 1: Composite PK `(__ns, id)` for multi-tenant resource tables
- **Status**: PASS
- **Evidence**: `datafn/cli/src/drizzle-codegen.ts` — when `isMultiTenant`, `buildColumnDefinition()` now emits `.notNull()` instead of `.primaryKey()` for `id`, and composite `primaryKey({ columns: [table.__ns, table.id] })` is added in the table callback.
- **Test status**: 39/39 codegen tests pass including all multi-tenant codegen tests (TV-SCH-002, TV-SCH-003, TV-SCH-004).

### Requirement 2: Composite PK `(__ns, id)` for multi-tenant join tables
- **Status**: PASS
- **Evidence**: `datafn/cli/src/drizzle-codegen.ts` — join table `id` field uses `.notNull()` instead of `.primaryKey()` when multi-tenant, and composite PK is added in the table callback.
- **Test status**: 39/39 codegen tests pass.

### Requirement 3: Upsert conflict target includes `__ns` in multi-tenant mode
- **Status**: PASS
- **Evidence**: `packages/db/src/adapter/row-level-namespace.ts` — `upsert()` method now augments `conflictTarget` to prepend the namespace column (`__ns`), so `ON CONFLICT` uses `(__ns, id)` instead of `(id)`.
- **Test status**: 63/63 sync tests pass, 26/26 mutation tests pass.

### Requirement 4: Single-tenant mode (`multiTenant: false`) unchanged
- **Status**: PASS
- **Evidence**: When `isMultiTenant` is false, `buildColumnDefinition()` still emits `.primaryKey()` on `id`, no composite PK callback is generated, and the namespace wrapper is not active (no `conflictTarget` augmentation).
- **Test status**: All existing `multiTenant: false` tests pass unchanged.

### Requirement 5: Example todo-app schema updated
- **Status**: PASS
- **Evidence**: `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts` regenerated with composite PKs for all tables.

## Implementation Summary

### Files Changed
| File | Change |
|---|---|
| `datafn/cli/src/drizzle-codegen.ts` | (1) `buildColumnDefinition()` accepts `isMultiTenant` param, emits `.notNull()` instead of `.primaryKey()` on `id` when multi-tenant. (2) Resource table callback emits `primaryKey({ columns: [table.__ns, table.id] })`. (3) Join table `id` field skips `.primaryKey()` when multi-tenant. (4) Join table callback emits composite PK. (5) `primaryKey` added to imports when needed. |
| `packages/db/src/adapter/row-level-namespace.ts` | `upsert()` method augments `conflictTarget` to include namespace column (`__ns`), converting string to array. |
| `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts` | Regenerated with composite PKs (`primaryKey({ columns: [table.__ns, table.id] })`) for all 4 tables. |

### Key Changes
- **Composite PK in codegen**: All resource and join tables now use `(__ns, id)` as composite primary key when `multiTenant` is true (the default).
- **Conflict target augmentation**: The row-level-namespace wrapper prepends `__ns` to any `conflictTarget` passed to `upsert()`, ensuring `ON CONFLICT` respects namespace boundaries.
- No changes needed to `push.ts`, `execute.ts`, or `relations.ts` — the namespace wrapper transparently handles the conflict target augmentation.

## Verification Summary

### Test Execution
- `datafn/cli/__tests__/drizzle-codegen.test.ts`: **39/39 passed** — all codegen tests including multi-tenant
- `datafn/server/__tests__/sync*.test.ts`: **63/63 passed** — sync push/pull tests
- `datafn/server/__tests__/mutation-optimization.test.ts` + `server/src/execution/mutation/__tests__/`: **26/26 passed** — mutation tests

### Pre-existing Failures
- 30 tests fail in the full suite (CLI auto-discovery, client types, query pushdown, status endpoint) — confirmed pre-existing, unrelated to this issue.

## Notes

- The fix follows **Option A** from the issue (composite PK at the database level), which is the principled approach.
- Existing deployments will need a migration to drop the single-column PK and create the composite PK. This is a DDL change that Drizzle Kit will generate automatically when running `drizzle-kit generate`.
- The `kvId()` function in `datafn/core/src/kv.ts` was NOT modified — it still produces `"kv:" + key`. This is correct because namespace scoping is now handled at the database level via the composite PK.
- The row-level-namespace wrapper augments `conflictTarget` for ALL upserts when namespace isolation is active, which correctly handles not just KV but all resources and join tables.
