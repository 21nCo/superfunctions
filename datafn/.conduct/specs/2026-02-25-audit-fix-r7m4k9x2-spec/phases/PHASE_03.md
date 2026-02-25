# PHASE 03: IN_MEMORY Targeted Secondary Resource Loading

## Phase Goal

Modify `DbDataStore.forQuery()` to load secondary resources using targeted `IN` queries scoped to IDs referenced by the pre-filtered primary resource set, instead of loading entire secondary tables.

## In Scope

- INMEM-001: Targeted secondary loading for relation filters (many-many, many-one, one-many)
- INMEM-002: Targeted secondary loading for relation selects
- INMEM-003: Empty primary set fast-path
- INMEM-004: Fallback to full load with warning

## Out of Scope

- Changes to the query planner's classification logic (unchanged)
- Changes to FULL_PUSHDOWN or PARTIAL_PUSHDOWN paths (unchanged)
- Changes to filter/sort/select evaluation logic (unchanged — only the DATA LOADING step changes)

## Deliverables

- Modified: `datafn/server/src/execution/db-store.ts` (primarily `forQuery()` and `create()`)
- New/Modified: `datafn/server/__tests__/query-pushdown.test.ts` (add IN_MEMORY secondary loading vectors)

## Requirements Covered

- INMEM-001, INMEM-002, INMEM-003, INMEM-004

## Implementation Tasks

### Core: Targeted Secondary Loading

- [ ] **T1**: In `db-store.ts`, within the `forQuery()` method, after the primary resource is loaded with SCALE-004 pre-filtering, extract the primary record IDs and FK values.
- [ ] **T2**: For each secondary resource in `resourcesToLoad`:
  - Determine the relation path from schema: is it many-one (FK on primary), one-many (FK on secondary), or many-many (join table)?
  - **Many-one forward**: Extract unique FK values from primary records → `findMany({ model: secondary, where: [{ field: "id", operator: "in", value: fkValues }] })`.
  - **One-many inverse**: Extract primary IDs → `findMany({ model: secondary, where: [{ field: fkField, operator: "in", value: primaryIds }] })`.
  - **Many-many**: Load join table rows filtered by primary IDs → extract secondary IDs → `findMany({ model: secondary, where: [{ field: "id", operator: "in", value: secondaryIds }] })`.
- [ ] **T3**: Modify `DbDataStore.create()` to accept an optional `targetedLoading` parameter:
  ```typescript
  static async create(
    db: Adapter,
    resources: string[],
    namespace: string,
    primaryResource?: string,
    primaryWhere?: WhereClause[],
    targetedSecondaryConfig?: Map<string, WhereClause[]>,  // NEW
  ): Promise<DbDataStore>
  ```
  When a resource has a targeted config, use those where clauses instead of loading all records.
- [ ] **T4**: In `forQuery()`, after loading the primary resource, build the `targetedSecondaryConfig` map based on relation analysis and primary record data.
- [ ] **T5**: Handle the case where the relation definition is incomplete (INMEM-004): if FK field, join table, or join columns cannot be determined, set the targeted config to `undefined` for that resource (triggering full load) and emit `console.warn`.

### Fast Path: Empty Primary Set

- [ ] **T6**: In `forQuery()`, after the primary resource load, if the primary records array is empty AND SCALE-004 pre-filtering was applied, return an empty store immediately without loading any secondary resources.

### Tests

- [ ] **T7**: Add test TV-INMEM-SEC-001: many-many relation, spy on `findMany`, verify secondary loaded with `IN` filter on referenced IDs only.
- [ ] **T8**: Add test TV-INMEM-SEC-002: many-one relation, verify secondary loaded with `IN` filter on FK values.
- [ ] **T9**: Add test TV-INMEM-SEC-003: one-many relation, verify secondary loaded with `IN` filter on primary IDs.
- [ ] **T10**: Add test TV-INMEM-SEC-004: both filter and select need same secondary — loaded once.
- [ ] **T11**: Add test TV-INMEM-SEC-005: empty primary set → no secondary findMany calls.
- [ ] **T12**: Add test TV-INMEM-SEC-006: incomplete schema → fallback to full load + warning emitted.
- [ ] **T13**: Run ALL existing query tests to verify no regressions. This is CRITICAL — the IN_MEMORY path handles complex queries and any bug here could silently produce wrong results.

## Verification Steps

1. Run: `cd datafn/server && npx vitest run --reporter=verbose __tests__/query-pushdown.test.ts`
   - Expected: All new TV-INMEM-SEC vectors pass.
2. Run: `cd datafn/server && npx vitest run --reporter=verbose __tests__/dfql-select.test.ts`
   - Expected: All existing select/relation tests pass (regression gate).
3. Run: `cd datafn/server && npx vitest run --reporter=verbose`
   - Expected: Full test suite passes.
4. Run: `cd datafn/server && npx tsc --noEmit`
   - Expected: No type errors.

## Stop Condition

Report: (a) all new test results, (b) a comparison showing findMany call counts for a sample IN_MEMORY query before/after (e.g., "previously loaded 1000 tag records, now loads 3"), (c) confirmation ALL existing tests pass — any regression in query results MUST be investigated and fixed before marking this phase complete.
