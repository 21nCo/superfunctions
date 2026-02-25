# PHASE 03: Partial Push-Down and In-Memory Pre-Filtering

## Phase Goal

Implement the PARTIAL_PUSHDOWN execution path (primary records pushed down, relations loaded on-demand) and the IN_MEMORY pre-filtering optimization (base-field filters pushed down even for complex queries).

## In Scope

- Partial push-down: push base-resource filters/sort/limit to adapter, then targeted relation loading
- In-memory pre-filtering: extract pushable base-field filters for IN_MEMORY queries
- Targeted relation loading: load only related records referenced by the primary result set
- Integration with `DbDataStore` for relation materialization only

## Out of Scope

- Rewriting the select materialization logic (it continues to use `DataStore` interface)
- Optimizing relation filter evaluation (stays in-memory)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/db-store.ts` | MODIFY — add `forPushdownResult()` static method for targeted loading |
| `datafn/server/src/execution/query/pushdown.ts` | MODIFY — add `executePartialPushdownQuery()` |
| `datafn/server/src/execution/query/execute.ts` | MODIFY — wire PARTIAL_PUSHDOWN strategy |
| `datafn/server/src/routes/query.ts` | MODIFY — wire PARTIAL_PUSHDOWN and IN_MEMORY pre-filter paths |
| `datafn/server/__tests__/query-pushdown.test.ts` | MODIFY — add partial push-down and pre-filter tests |

## Requirements Covered

- SCALE-003 (Partial push-down for relation-select queries)
- SCALE-004 (In-memory fallback with base-field pre-filtering)

## Implementation Tasks

1. Add `DbDataStore.forPushdownResult()`:
   ```typescript
   static async forPushdownResult(
     db: Adapter,
     primaryRecords: Record<string, unknown>[],
     primaryResource: string,
     query: { select?: string[] },
     schema: DatafnSchema,
     namespace: string,
   ): Promise<DbDataStore>
   ```
   - Pre-populate `recordsCache` for the primary resource with the provided records (no DB fetch)
   - Discover needed related resources from select tokens (reuse logic from `forQuery`)
   - For many-one relations: collect FK values from primary records, fetch related via `findMany({ where: [{ field: "id", operator: "in", value: fkIds }] })`
   - For one-many relations: fetch via `findMany({ where: [{ field: fkField, operator: "in", value: primaryIds }] })`
   - For many-many relations: fetch join table rows, then fetch related records by ID
   - This ensures only referenced records are loaded, not all records of related resources

2. Add `executePartialPushdownQuery()` to `pushdown.ts`:
   - Push filters/sort/limit to adapter for primary resource (same as full push-down)
   - Create `DbDataStore.forPushdownResult()` with the adapter results
   - Call `materializeSelect()` with the store for relation expansion
   - Compute nextCursor and handle pagination as in full push-down

3. Modify `DbDataStore.create()` to accept pre-filtering:
   - Existing `DbDataStore.forQuery()` for IN_MEMORY path SHOULD accept optional `where` clauses
   - Use `extractPushableFilters()` from planner to get base-field filters
   - Pass pushable filters to `db.findMany({ where: pushableFilters })` for the primary resource
   - Related resources still load fully (they need full scan for relation quantifier evaluation)

4. Update route handler dispatch to include PARTIAL_PUSHDOWN and IN_MEMORY pre-filter paths.

5. Tests:
   - TV-PARTIAL-001: many-many relation targeted load (verify adapter calls)
   - TV-PARTIAL-002: many-one relation targeted load
   - TV-INMEM-001: base-field filter pushed down for IN_MEMORY query (verify adapter call has where clause)
   - Regression: all existing dfql-select tests pass

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/query-pushdown.test.ts
npx vitest run __tests__/dfql-select.test.ts
npx vitest run
npx tsc --noEmit
```

**Expected**: All tests pass. Targeted loading verified through mock adapter call assertions.

## Stop Condition

Report: Partial push-down and IN_MEMORY pre-filtering implemented. All query strategies operational. Full regression suite passes.
