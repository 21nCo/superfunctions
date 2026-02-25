# PHASE 00: DFQL-to-Adapter Filter/Sort/Limit Conversion

## Phase Goal

Implement utility functions that convert DFQL filter expressions, sort terms, and pagination parameters to the `@superfunctions/db` adapter's `WhereClause[]`, `OrderBy[]`, and `limit`/`offset` format.

## In Scope

- `convertDfqlFilters()` — full and partial extraction modes
- `convertDfqlSort()` — DFQL sort terms to `OrderBy[]`
- Unit tests for all conversion functions

## Out of Scope

- QueryPlanner classification (Phase 01)
- Actual push-down execution path (Phase 02)
- Relation filter handling (remains in-memory)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/query/planner.ts` | CREATE — conversion utilities (will be extended with classification in Phase 01) |
| `datafn/server/__tests__/query-planner.test.ts` | CREATE — unit tests for conversion functions |

## Requirements Covered

- SCALE-005 (DFQL-to-WhereClause conversion)
- SCALE-006 (DFQL-to-OrderBy conversion)
- SCALE-007 (limit/offset pass-through — type definitions)

## Implementation Tasks

1. Create `datafn/server/src/execution/query/planner.ts` with:
   - `convertDfqlFilters(filters, resource, schema)` → `WhereClause[] | null`
     - Handle `$eq`/`eq`, `$ne`/`ne`, `$gt`/`gt`, `$gte`/`gte`, `$lt`/`lt`, `$lte`/`lte`, `$in`/`in`, `$like`/`like`, `$ilike`/`ilike`
     - Handle shorthand equality: `{ status: "active" }` → eq
     - Handle `$and` flattening
     - Return `null` for `$or`, relation quantifiers (`$any`/`$all`/`$none`), dot-path filters
   - `extractPushableFilters(filters, resource, schema)` → `{ pushable: WhereClause[], remaining: Record<string, unknown> | null }`
     - Separate base-field filters (pushable) from relation/complex filters (remaining)
   - `convertDfqlSort(sort?: string[])` → `OrderBy[]`
     - Reuse `parseSortTerms` from `sort.ts` and map `SortTerm` to `OrderBy`
     - Handle `-field` prefix for descending
     - Default to `[{ field: "id", direction: "asc" }]` when sort is undefined
2. Create unit tests covering TV-CONVERT-001, TV-CONVERT-002, TV-CONVERT-003, TV-CONVERT-004, TV-SORT-001.

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/query-planner.test.ts
npx tsc --noEmit
```

**Expected**: All conversion tests pass. TypeScript compiles cleanly.

## Stop Condition

Report: conversion utilities implemented and tested. Ready for Phase 01 (classification).
