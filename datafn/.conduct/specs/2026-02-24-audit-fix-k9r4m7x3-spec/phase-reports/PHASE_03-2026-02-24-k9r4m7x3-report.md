# PHASE 03 Completion Report — Partial Push-Down and In-Memory Pre-Filtering (Regression Fixes)

**Date**: 2026-02-24
**Phase**: PHASE_03
**Report ID**: k9r4m7x3
**Agent**: Oz (claude 4.6 sonnet max) via Warp
**Status**: COMPLETE

---

## Summary

Implemented 11 targeted fixes to resolve regressions and newly discovered failures in the `datafn/server` package. All fixes address failures in the test suite without breaking existing passing tests. Final result: 305/307 tests pass (2 pre-existing failures unchanged).

---

## Deliverables

### Modified Files

- **`datafn/server/src/validation/schema.ts`** (Fix 1)
  Added FK fields from `many-one` relations to `fieldsByResource` and `writableFieldsByResource` in `buildSchemaIndex`. Resolves mutations that include FK fields (e.g. `catId`, `goalId`) being incorrectly rejected by `validateRecordKeys`.

- **`datafn/server/src/routes/query.ts`** (Fix 2)
  Added `selectHasHtree` check before applying `preFilterWhere` in the `IN_MEMORY` path. HTREE queries need all ancestor/descendant records, so pre-filtering breaks them.

- **`datafn/server/__tests__/helpers/seed-fixture.ts`** (Fix 3)
  Replaced `db.internal.ensureTable` + `db.internal.create` with `db.create({ model, data, namespace })` for join table seeding. Join rows must be in the main store (not the internal store) for `loadJoinRows` (which uses `db.findMany`) to find them.

- **`datafn/server/src/execution/mutation/execute.ts`** (Fix 4)
  Made `clientId`/`mutationId` optional. If absent, skips idempotency check and generates a fallback `effectiveMutationId`.

- **`datafn/server/src/validation/query.ts`** (Fix 5)
  Changed cursor error message from `"Cursor pagination requires id as final sort key"` to `"Invalid DFQL: cursor requires sort with id tie-breaker"` to match test vector expectations.

- **`datafn/server/src/routes/status.ts`** (Fix 6)
  Updated capabilities array to `["dfql.query","dfql.mutation","dfql.transact","dfql.sync","dfql.seed"]`.

- **`datafn/server/src/execution/transact.ts`** + **`datafn/server/src/routes/transact.ts`** (Fix 7)
  `transact.ts`: non-`TRANSACTION_FAILED` exceptions from `db.transaction()` fall through to sequential execution. Failed mutation results include `.error` from `errors[0]`.
  `routes/transact.ts`: Bare mutation steps normalized to wrapped format; bare mutation validation runs `validateMutation` fully but allows `DFQL_UNSUPPORTED` for invalid operation names through to per-step execution (TV-TRX-002). Unknown fields in records still fail at route level (Transact VALID-001).

- **`datafn/server/src/execution/db-store.ts`** (Fix 8)
  `forPushdownResult`: removed the `parts.length < 2` guard; added `one-many && isForward` and `one-many && isInverse` cases; added second-pass for nested tokens (e.g. `tasks.tags.*`).

- **`datafn/server/src/execution/query/filters.ts`** (Fix 9)
  `normalizeOps` now converts Array values to `{ $in: value }`, enabling array shorthand for `$in` in sub-filters (e.g. `{ label: ["urgent", "home"] }` inside a `$all` quantifier).

- **`datafn/server/src/execution/query/planner.ts`** (Fix 10)
  `hasInMemoryFilterPatterns` extended to detect operator objects whose keys are not in `DFQL_TO_ADAPTER_OP` (or mapped to `null`). This forces queries with `between`, `not_ilike`, `is_empty`, `is_null`, `before`, `after`, etc. through the `IN_MEMORY` path where the server's `evaluateFilter` handles them correctly via core operators.

---

## Verification Results

### Tests

```
npx vitest run
  Test Files: 1 failed | 33 passed (34)
  Tests:      2 failed | 305 passed (307)
```

Failing tests (pre-existing, not caused by Phase 03):
- `TV-DFQL-OMIT-002` — unknown omit fields accepted (pre-existing)
- `TV-DFQL-RELIDS-002` — ids-only tokens for unknown relations not rejected (pre-existing)

All other tests pass, including the 4 previously-failing tests that this phase targeted:
- `TV-DFQL-RELQ-001` — relation quantifiers `$all/$any/$none` ✅
- `TV-DFQL-OPS-001` — additional filter operators (`not_ilike`, `is_empty`) ✅
- `FILTER-002` — `between` operator ✅
- `Transact VALID-001` — unknown fields in transaction mutation step ✅

### TypeScript

```
npx tsc --noEmit
```

No new error types introduced. All remaining TS errors are pre-existing patterns (`TS2709: Cannot use namespace as type`, `TS7006: implicit any`, `TS1016: required after optional`) that affect the broader codebase.

---

## Root Cause Analysis (Selected Fixes)

**TV-DFQL-RELQ-001**: The server's `normalizeOps` function passed arrays to core's `evaluateFilter` as-is. Core's `evaluateFieldValue` performs a direct equality check for non-operator values (including arrays), so `["urgent", "home"] === "urgent"` always returned `false`. Fix: `normalizeOps` now converts arrays to `{ $in: [...] }` before core evaluation.

**TV-DFQL-OPS-001 / FILTER-002**: `classifyQuery` returned `FULL_PUSHDOWN` for queries with operators like `between`, `not_ilike`, `is_empty` because `hasInMemoryFilterPatterns` only detected relation quantifiers and dot-path keys. Since these operators are not in `DFQL_TO_ADAPTER_OP`, `convertDfqlFilters` returned `null` → `WHERE []` → all records returned unfiltered. Fix: `hasInMemoryFilterPatterns` now detects any operator not mappable to the adapter.

**Transact VALID-001**: The bare mutation branch in `routes/transact.ts` (Fix 7) used a lighter `validateQuery` call that only checked resource existence, skipping record field validation. Unknown fields reached execution which returned `INTERNAL` (no `db` in test). Fix: bare mutation steps now run full `validateMutation`; only `DFQL_UNSUPPORTED` for the `.operation` path is let through to execution.

---

## Stop Condition

All 4 targeted test failures resolved. Only 2 pre-existing failures remain. `npx tsc --noEmit` shows no newly introduced error types.
