# PHASE 01: Batch ServerSeq Allocation + Batch Change Recording

## Phase Goal

Implement `getNextN()` on `DatabaseSequenceStore` and `getNextServerSeqBatch()` + `recordChanges()` on `ChangeTrackingService`, enabling multi-delta mutations to allocate sequences and record changes in bulk.

## In Scope

- BATCH-SEQ-001: `DatabaseSequenceStore.getNextN()`
- BATCH-SEQ-002: `SequenceStore` interface update + `FallbackSequenceStore.getNextN()`
- BATCH-SEQ-003: `ChangeTrackingService.getNextServerSeqBatch()`
- BATCH-CHG-001: `ChangeTrackingService.recordChanges()`

## Out of Scope

- Modifying mutation execution to USE the batch methods (that's Phase 02)
- Adding `createMany` to the Adapter interface
- Redis `INCRBY` optimization for batch allocation

## Deliverables

- Modified: `datafn/server/src/execution/sync/sequence-store.ts`
- Modified: `datafn/server/src/execution/sync/change-tracking.ts`
- New/Modified: `datafn/server/__tests__/sync-bounded.test.ts` (add batch test vectors)

## Requirements Covered

- BATCH-SEQ-001, BATCH-SEQ-002, BATCH-SEQ-003, BATCH-CHG-001

## Implementation Tasks

- [ ] **T1**: In `sequence-store.ts`, add `getNextN(namespace: string, count: number): Promise<number[]>` to the `SequenceStore` interface.
- [ ] **T2**: Implement `DatabaseSequenceStore.getNextN()`:
  - Validate `count` is a positive integer ≤ 1000.
  - Same CAS retry loop as `getNext()`, but increment by `count` instead of 1.
  - Return array `[current, current+1, ..., current+count-1]`.
- [ ] **T3**: Reimplement `DatabaseSequenceStore.getNext()` as `(await this.getNextN(namespace, 1))[0]` to avoid duplication.
- [ ] **T4**: Implement `FallbackSequenceStore.getNextN()`:
  - Same health-check + fallback pattern as `getNext()`.
  - Delegates to `primary.getNextN()` or `fallback.getNextN()`.
- [ ] **T5**: In `change-tracking.ts`, add `getNextServerSeqBatch(count: number): Promise<number[]>` that delegates to `this.sequenceStore.getNextN(this.namespace, count)`.
- [ ] **T6**: In `change-tracking.ts`, add `recordChanges(entries: ChangeEntryInput[]): Promise<void>`:
  - Ensure internal table once (same guard as `recordChange`).
  - Iterate entries and call `db.internal.create()` for each.
  - Propagate errors immediately.
- [ ] **T7**: Optionally reimplement `recordChange()` as `this.recordChanges([entry])`.
- [ ] **T8**: Add tests: TV-BATCH-SEQ-001 (contiguous range), TV-BATCH-SEQ-002 (count=1), TV-BATCH-SEQ-003 (invalid count), TV-BATCH-SEQ-004 (fallback delegation).
- [ ] **T9**: Add tests: TV-BATCH-CHG-001 (multiple entries), TV-BATCH-CHG-002 (error propagation).
- [ ] **T10**: Run all existing tests to verify no regressions.

## Verification Steps

1. Run: `cd datafn/server && npx vitest run --reporter=verbose __tests__/sync-bounded.test.ts`
   - Expected: All new batch test vectors pass.
2. Run: `cd datafn/server && npx vitest run --reporter=verbose`
   - Expected: All existing tests pass.
3. Run: `cd datafn/server && npx tsc --noEmit`
   - Expected: No type errors.

## Stop Condition

Report: (a) all new test results, (b) confirmation `getNext()` is now a thin wrapper over `getNextN()`, (c) confirmation existing tests pass.
