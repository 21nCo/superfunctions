# PHASE 02: Relation Mutation Optimization

## Phase Goal

Optimize `executeRelate()` to use batch target validation (single `findMany` instead of per-item `findOne`), `upsert()` for many-many joins (instead of `findOne` + conditional create/update), and batch serverSeq + batch change recording for relation deltas.

## In Scope

- REL-OPT-001: Batch target existence validation
- REL-OPT-002: Upsert for many-many join operations
- BATCH-CHG-002: Mutation execution uses batch recording for relation deltas

## Out of Scope

- Changes to `modifyRelation` or `unrelate` operations (separate concern)
- Changes to non-relation mutations (insert/merge/replace/delete — already optimized by prior spec)

## Deliverables

- Modified: `datafn/server/src/execution/mutation/relations.ts`
- Modified: `datafn/server/src/execution/mutation/execute.ts`
- New/Modified: `datafn/server/src/execution/mutation/__tests__/relations.test.ts` (add optimization test vectors)
- New/Modified: `datafn/server/__tests__/mutation-optimization.test.ts` (add batch recording test vectors)

## Requirements Covered

- REL-OPT-001, REL-OPT-002, BATCH-CHG-002

## Implementation Tasks

### Batch Target Validation (REL-OPT-001)

- [ ] **T1**: In `relations.ts` `executeRelate()`, replace the per-item target validation loop (lines 88-103) with a single batch validation:
  - Collect all target IDs: `const targetIds = items.map(i => i.toId)`.
  - Call `adapter.findMany({ model: relation.to, where: [{ field: "id", operator: "in", value: targetIds }], namespace })`.
  - Build a `Set` of existing IDs from the result.
  - Check each target ID against the set; return NOT_FOUND for the first missing ID.
- [ ] **T2**: Add test TV-REL-OPT-001: verify `findMany` called once with `IN` filter, all targets exist, mutation succeeds.
- [ ] **T3**: Add test TV-REL-OPT-002: verify missing target detected, correct error returned, no writes executed.

### Many-Many Join Upsert (REL-OPT-002)

- [ ] **T4**: In `relations.ts`, replace the many-many join loop (lines 147-180) that uses `findOne` + conditional `create`/`update` with `adapter.upsert()`:
  ```typescript
  for (const item of items) {
    await adapter.upsert({
      model: tableName,
      where: [
        { field: fromCol, operator: "eq", value: mutation.id },
        { field: toCol, operator: "eq", value: item.toId },
      ],
      create: { id: `${mutation.id}:${item.toId}`, [fromCol]: mutation.id, [toCol]: item.toId, ...item.metadata },
      update: Object.keys(item.metadata).length > 0 ? item.metadata : {},
      namespace,
    });
  }
  ```
- [ ] **T5**: Add test TV-REL-OPT-003: new join row created via upsert, verify `findOne` NOT called.
- [ ] **T6**: Add test TV-REL-OPT-004: existing join row updated with metadata via upsert.

### Batch Delta Recording (BATCH-CHG-002)

- [ ] **T7**: In `execute.ts`, modify the relation mutation change recording block (lines 325-355):
  - Collect all FK deltas and join deltas into arrays.
  - Calculate total delta count: `const totalDeltas = fkDeltas.length + joinDeltas.length`.
  - Call `changeTracking.getNextServerSeqBatch(totalDeltas)` once.
  - Assign sequences to deltas in order (FK deltas first, then join deltas).
  - Build the entries array and call `changeTracking.recordChanges(entries)` once.
- [ ] **T8**: Add test TV-BATCH-CHG-003: verify `getNextServerSeqBatch` called once with correct count, `recordChanges` called once with correct entries, existing singular path unchanged for non-relation mutations.
- [ ] **T9**: Run all existing mutation and relation tests to verify no regressions.

## Verification Steps

1. Run: `cd datafn/server && npx vitest run --reporter=verbose src/execution/mutation/__tests__/relations.test.ts`
   - Expected: TV-REL-OPT-001..004 pass, existing relation tests pass.
2. Run: `cd datafn/server && npx vitest run --reporter=verbose __tests__/mutation-optimization.test.ts`
   - Expected: TV-BATCH-CHG-003 passes.
3. Run: `cd datafn/server && npx vitest run --reporter=verbose`
   - Expected: All tests pass.
4. Run: `cd datafn/server && npx tsc --noEmit`
   - Expected: No type errors.

## Stop Condition

Report: (a) all new test results, (b) before/after DB call counts for a relate-with-5-items mutation (should drop from ~15-20 calls to ~5-7), (c) confirmation existing tests pass.
