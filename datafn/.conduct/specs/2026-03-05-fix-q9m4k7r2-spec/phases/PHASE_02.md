# PHASE_02

## Phase goal

Eliminate false success by coupling applied/change-tracking to real persistence and add SQL-backed regression coverage for KV first-write.

## In scope / Out of scope

- **In scope**:
  - Applied list and change-tracking gating.
  - SQL-backed server regression tests.
  - KV first-write persistence test.
- **Out of scope**:
  - Documentation polish and manual example verification.

## Deliverables

- `datafn/server/src/execution/sync/push.ts` (MODIFY)
- `datafn/server/src/execution/mutation/execute.ts` (MODIFY as needed for accounting symmetry)
- `datafn/server/__tests__/merge-sql-regression.test.ts` (ADD)
- `datafn/server/__tests__/sync-ordering.test.ts` (MODIFY if needed for applied/change assertions)

## Requirements covered

- KV-001
- OBS-001
- ERR-001
- TST-001

## Implementation tasks

- [ ] Ensure mutation IDs are appended to `applied` only on persisted write outcomes.
- [ ] Prevent change-tracking entry creation for non-applied merges.
- [ ] Add SQL-backed regression tests for `kv.set` first-write persistence and missing-merge non-applied behavior.
- [ ] Add assertions that old false-success behavior would fail.

## Verification steps

1. `npx vitest run datafn/server/__tests__/merge-sql-regression.test.ts`
   - Expected: SQL-backed regression tests pass.
2. `npx vitest run datafn/server/__tests__/sync-ordering.test.ts datafn/server/__tests__/execution-errors.test.ts`
   - Expected: no regressions in ordering and error behavior.

## Stop condition

Report zero false-success scenarios in SQL-backed tests and stable applied/change-tracking assertions.
