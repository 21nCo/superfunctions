# PHASE 00: Fix getLatestServerSeq Unbounded Fetch

## Phase Goal

Fix `ChangeTrackingService.getLatestServerSeq()` to use DESC ordering with `limit: 1` instead of fetching all change entries, reducing the operation from O(N) to O(1).

## In Scope

- SEQ-001: Fix `getLatestServerSeq()` in `change-tracking.ts`

## Out of Scope

- Python `get_latest_cursor` (already uses `limit=1` + DESC — no change needed)
- Any changes to `getChangesSince` or `recordChange`

## Deliverables

- Modified: `datafn/server/src/execution/sync/change-tracking.ts`
- New/Modified: `datafn/server/__tests__/sync-bounded.test.ts` (add test vectors TV-SEQ-001, TV-SEQ-002)

## Requirements Covered

- SEQ-001

## Implementation Tasks

- [ ] **T1**: In `change-tracking.ts`, locate the `getLatestServerSeq()` method (lines 325-350).
- [ ] **T2**: Change the `findMany` call from `{ orderBy: "server_seq" }` to `{ orderBy: "-server_seq", limit: 1 }`.
- [ ] **T3**: Change the return value from `changes[changes.length - 1].server_seq` to `changes[0]?.server_seq ?? 0`.
- [ ] **T4**: Verify the `db.internal.findMany` method supports negative-prefix ordering (e.g., `"-server_seq"` for DESC). Check the `InternalCrud` interface in `packages/db/src/adapter/types.ts`. If not supported, use an alternative approach (e.g., pass `orderBy: "server_seq"` with a `direction: "desc"` parameter, or use whatever format the internal adapter accepts).
- [ ] **T5**: Add test TV-SEQ-001: spy on `db.internal.findMany`, verify it is called with DESC ordering and `limit: 1`, verify correct value returned.
- [ ] **T6**: Add test TV-SEQ-002: empty changes case, verify returns 0.
- [ ] **T7**: Run existing sync tests to verify no regressions (`npm test` in `datafn/server`).

## Verification Steps

1. Run: `cd datafn/server && npx vitest run --reporter=verbose __tests__/sync-bounded.test.ts`
   - Expected: TV-SEQ-001 and TV-SEQ-002 pass.
2. Run: `cd datafn/server && npx vitest run --reporter=verbose`
   - Expected: All existing tests pass (no regressions).
3. Run: `cd datafn/server && npx tsc --noEmit`
   - Expected: No new type errors.

## Stop Condition

Report: (a) test results for new vectors, (b) confirmation existing tests pass, (c) the exact `findMany` call signature used (to document for Phase 01).
