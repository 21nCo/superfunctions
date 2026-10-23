# PHASE 01: QueryPlanner Classification

## Phase Goal

Implement the `classifyQuery()` function that determines the execution strategy for a DFQL query: `FULL_PUSHDOWN`, `PARTIAL_PUSHDOWN`, or `IN_MEMORY`.

## In Scope

- `classifyQuery(query, schema)` function
- Strategy type enum
- Unit tests for classification logic

## Out of Scope

- Executing queries with push-down (Phase 02)
- Partial push-down execution (Phase 03)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/query/planner.ts` | MODIFY — add `classifyQuery()` and `QueryStrategy` enum |
| `datafn/server/__tests__/query-planner.test.ts` | MODIFY — add classification tests |

## Requirements Covered

- SCALE-001 (QueryPlanner classification)

## Implementation Tasks

1. Add `QueryStrategy` enum to `planner.ts`:
   ```typescript
   export type QueryStrategy = 'FULL_PUSHDOWN' | 'PARTIAL_PUSHDOWN' | 'IN_MEMORY';
   ```
2. Implement `classifyQuery(query, schema)`:
   - Check for `search` field → `IN_MEMORY`
   - Check for `groupBy` field → `IN_MEMORY`
   - Check select tokens for HTREE (`parent.*`, `children.*`, `children.**`) → `IN_MEMORY`
   - Check filters for relation quantifiers (`$any`/`$all`/`$none`) or dot-path keys → `IN_MEMORY`
   - Check select tokens for relation expansion (`rel.*`, `rel.#`, `rel.*#`, nested traversals) → `PARTIAL_PUSHDOWN`
   - Check select tokens for ids-only relation tokens (bare `tags` without directive) → `PARTIAL_PUSHDOWN`
   - Otherwise → `FULL_PUSHDOWN`
3. Add unit tests for TV-PLAN-001, TV-PLAN-002, TV-PLAN-003, TV-PLAN-004.
4. Add edge case tests:
   - Query with `select: ["*"]` and no relations → `FULL_PUSHDOWN`
   - Query with `select: ["id", "title"]` → `FULL_PUSHDOWN`
   - Query with `count: true` only → `FULL_PUSHDOWN` (count can be pushed down via adapter's `count()`)
   - Query with `having` → `IN_MEMORY` (having implies groupBy)

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/query-planner.test.ts
npx tsc --noEmit
```

**Expected**: All classification tests pass. No type errors.

## Stop Condition

Report: `classifyQuery` implemented and tested for all three strategy types. Ready for Phase 02 (execution).
