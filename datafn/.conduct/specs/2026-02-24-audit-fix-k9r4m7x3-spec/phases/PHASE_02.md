# PHASE 02: Full Push-Down Execution Path

## Phase Goal

Implement the full push-down execution path where simple queries are executed entirely via the adapter's `findMany` method, bypassing `DbDataStore` completely. This is the primary fix for the audit's critical "In-Memory Query Execution" finding.

## In Scope

- New `executePushdownQuery()` function
- Integration with `executeQuery()` dispatch based on `classifyQuery()`
- Integration with `createQueryHandler()` in `routes/query.ts`
- Cursor pagination via where clause extension for push-down path
- nextCursor computation from push-down results
- All existing query tests continue to pass

## Out of Scope

- Partial push-down (Phase 03)
- IN_MEMORY pre-filtering optimization (Phase 03)
- Observability timing (Phase 08)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/query/pushdown.ts` | CREATE — push-down execution function |
| `datafn/server/src/execution/query/execute.ts` | MODIFY — add strategy dispatch |
| `datafn/server/src/routes/query.ts` | MODIFY — use new execution path |
| `datafn/server/__tests__/query-pushdown.test.ts` | CREATE — integration tests |

## Requirements Covered

- SCALE-002 (Full push-down execution)
- SCALE-005 (filter conversion — used here)
- SCALE-006 (sort conversion — used here)
- SCALE-007 (limit/offset pass-through)

## Implementation Tasks

1. Create `datafn/server/src/execution/query/pushdown.ts`:
   ```typescript
   export async function executePushdownQuery(
     query: DFQLQuery,
     schema: DatafnSchema,
     db: Adapter,
     namespace: string,
   ): Promise<QueryResult>
   ```
   - Convert filters via `convertDfqlFilters()`
   - Convert sort via `convertDfqlSort()`
   - Call `db.findMany({ model: query.resource, where, orderBy, limit: query.limit ? query.limit + 1 : undefined, offset: query.offset, namespace })`
   - Compute `nextCursor` from the `(limit+1)`th record
   - Trim results to `limit`
   - If `query.count === true`, also call `db.count()` with same where clauses
   - Materialize select tokens (simple field projection — no relation expansion needed for FULL_PUSHDOWN)
   - Handle `cursor.after` by adding where clauses: for sort `[{field: "priority", direction: "desc"}, {field: "id", direction: "asc"}]` and cursor `{ priority: 3, id: "t5" }`, add `WHERE (priority < 3) OR (priority = 3 AND id > 't5')`
   - Handle `cursor.before` similarly with reversed comparison
   - Apply `omit` field exclusion

2. Modify `datafn/server/src/execution/query/execute.ts`:
   - Import `classifyQuery` and `executePushdownQuery`
   - The current `executeQuery(query, schema, store)` remains for IN_MEMORY path
   - Add a new `executeQueryWithStrategy(query, schema, db, namespace, store?)` that:
     - Calls `classifyQuery()` to determine strategy
     - For `FULL_PUSHDOWN`: calls `executePushdownQuery(query, schema, db, namespace)`
     - For `PARTIAL_PUSHDOWN` and `IN_MEMORY`: delegates to existing `executeQuery(query, schema, store)` (store still required)

3. Modify `datafn/server/src/routes/query.ts`:
   - In the query handler, after validation:
     - Call `classifyQuery()` for each query
     - For `FULL_PUSHDOWN`: call `executePushdownQuery()` directly (skip `DbDataStore.forQuery()`)
     - For others: continue with existing `DbDataStore.forQuery()` → `executeQuery()` path
   - This is the critical change that prevents loading all records for simple queries

4. Create integration tests:
   - TV-PUSHDOWN-001: filter + sort + limit push-down with verification of adapter calls
   - TV-PUSHDOWN-002: offset pass-through
   - TV-PUSHDOWN-003: empty result set
   - Test cursor.after push-down
   - Test cursor.before push-down
   - Regression test: run all existing `dfql-select.test.ts` and `query-validation.test.ts`

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/query-pushdown.test.ts
npx vitest run __tests__/dfql-select.test.ts
npx vitest run __tests__/query-validation.test.ts
npx tsc --noEmit
```

**Expected**: All new tests pass. All existing tests pass. No type errors.

## Stop Condition

Report: Full push-down path implemented. Simple queries (no relations) bypass DbDataStore. Verify with a before/after comparison showing that `findMany` is called with filters instead of loading all records.
