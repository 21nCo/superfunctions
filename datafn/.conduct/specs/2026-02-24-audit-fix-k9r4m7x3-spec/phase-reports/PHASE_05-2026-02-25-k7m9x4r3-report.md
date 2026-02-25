# PHASE 05 Completion Report — Mutation Optimization (Upsert + Direct Create)

**Date**: 2026-02-25
**Phase**: PHASE_05
**Report ID**: k7m9x4r3
**Agent**: Claude Opus 4.6 via Claude Code
**Status**: COMPLETE

---

## Summary

Reduced mutation round-trips by replacing `findOne` pre-checks with optimized adapter calls. Merge operations now use `db.upsert()` (1 DB call instead of 3: findOne + create or update). Insert operations now use direct `db.create()` with error handling (1 DB call instead of 2: findOne + create). Also enforced uniqueness in the memory adapter's `create` method, which previously allowed silent overwrites.

---

## Deliverables

### Modified Files

- **`datafn/server/src/execution/mutation/execute.ts`** (MUT-001, MUT-002)
  - `merge` case: Replaced `findOne` → conditional `create`/`update` with single `db.upsert()` call. Creates if not found, updates if found, in one operation.
  - `insert` case: Removed `findOne` pre-existence check. Direct `db.create()` with error catching. Unique constraint errors (patterns: "unique", "duplicate", "already exists", "conflict") mapped to CONFLICT response.

- **`datafn/server/src/execution/sync/push.ts`** (MUT-003)
  - `merge`/`replace` case: Replaced `findOne` → conditional `create`/`update` with single `db.upsert()` call. Both merge and replace in push context use upsert since the client sends the full record.

- **`packages/db/src/adapters/memory/index.ts`** (bugfix)
  - Memory adapter's `create` method previously used `table.set()` which silently overwrites existing records. Added uniqueness enforcement: `if (table.has(id)) throw new Error(...)`. This is required for MUT-002's error-catching pattern to work with the memory adapter.

- **`datafn/server/__tests__/status.test.ts`** (Phase 04 fix)
  - Updated TV-COMP-001 to expect `maxPullLimit: 1000` in limits response (regression from Phase 04).

### Created Files

- **`datafn/server/__tests__/mutation-optimization.test.ts`**
  5 tests covering all Phase 05 test vectors:
  - TV-MUT-UPSERT-001: merge creates new record via upsert
  - TV-MUT-UPSERT-002: merge updates existing record via upsert (verifies merge semantics — unchanged fields preserved)
  - TV-MUT-INSERT-001: insert succeeds without findOne call
  - TV-MUT-INSERT-002: insert conflict detected from create error (HTTP 409, CONFLICT code)
  - TV-MUT-PUSH-001: push merge uses upsert (both create-new and update-existing in single push)

---

## Requirements Coverage

| Requirement | Status | Evidence |
|---|---|---|
| MUT-001 (Use upsert for merge) | PASS | TV-MUT-UPSERT-001, TV-MUT-UPSERT-002 pass |
| MUT-002 (Eliminate pre-existence check for insert) | PASS | TV-MUT-INSERT-001, TV-MUT-INSERT-002 pass |
| MUT-003 (Reduce push mutation round-trips) | PASS | TV-MUT-PUSH-001 passes |

---

## Verification Results

### New Tests

```
npx vitest run __tests__/mutation-optimization.test.ts
  Test Files: 1 passed (1)
  Tests:      5 passed (5)
```

### Regression Tests

```
npx vitest run __tests__/sync.test.ts
  Test Files: 1 passed (1)
  Tests:      33 passed (33)

npx vitest run datafn/server
  Test Files: 35 passed, 1 failed (36)
  Tests:      316 passed, 2 failed (318)
```

The 2 remaining failures (TV-DFQL-OMIT-002, TV-DFQL-RELIDS-002) are pre-existing and unrelated to Phase 05. TV-COMP-001 (status test) which was a Phase 04 regression was fixed in this phase.

### TypeScript

```
npx tsc --noEmit
```

No new errors introduced. All remaining TS errors are pre-existing patterns (TS2709, TS7006) in validation/ files.

---

## Key Decision: Memory Adapter Uniqueness

The memory adapter's `create` method previously used `table.set()` which is idempotent — it silently overwrites existing records. This meant duplicate inserts would succeed instead of failing. This was masked by the old `findOne` pre-check.

With MUT-002 removing the `findOne` pre-check, the adapter must enforce uniqueness itself. Added `if (table.has(id)) throw new Error(...)` to the memory adapter. This aligns the memory adapter's behavior with real database adapters (Drizzle, Prisma, Kysely) which throw on unique constraint violations.

**Important**: After modifying `packages/db/src/adapters/memory/index.ts`, the package must be rebuilt (`npm run build` in `packages/db/`) because the `@superfunctions/db` package exports from `./dist/`, not `./src/`.

---

## Stop Condition

Merge uses upsert (1 DB call instead of 3). Insert skips findOne (1 DB call instead of 2). No regressions in mutation or sync behavior.
