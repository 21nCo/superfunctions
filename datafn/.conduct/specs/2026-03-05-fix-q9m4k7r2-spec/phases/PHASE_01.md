# PHASE_01

## Phase goal

Implement unified schema-aware merge semantics for both mutation and push execution paths.

## In scope / Out of scope

- **In scope**:
  - Shared merge decision logic.
  - Mutation and push merge path alignment.
  - Required-field eligibility evaluation.
- **Out of scope**:
  - SQL-backed integration tests (handled in Phase 02).
  - Example app manual walkthrough (handled in Phase 03).

## Deliverables

- `datafn/server/src/execution/mutation/execute.ts` (MODIFY)
- `datafn/server/src/execution/sync/push.ts` (MODIFY)
- `datafn/server/src/execution/mutation/merge-decision.ts` (ADD)
- `datafn/server/__tests__/mutation-optimization.test.ts` (MODIFY)
- `datafn/server/__tests__/sync.test.ts` (MODIFY)

## Requirements covered

- MRG-001
- MRG-002
- MRG-003
- ERR-001 (partial)

## Implementation tasks

- [ ] Add shared merge decision helper that returns `update | create | not_found`.
- [ ] Implement eligibility check using schema required fields + defaults.
- [ ] Wire helper into `/datafn/mutation` merge path.
- [ ] Wire helper into `/datafn/push` merge path.
- [ ] Add single-retry conflict resolution for create race.
- [ ] Keep error mapping deterministic (`NOT_FOUND`, `INTERNAL`, `DFQL_INVALID`).

## Verification steps

1. `npx vitest run datafn/server/__tests__/mutation-optimization.test.ts`
   - Expected: merge existing passes; merge missing/ineligible returns NOT_FOUND.
2. `npx vitest run datafn/server/__tests__/sync.test.ts`
   - Expected: push merge behavior matches mutation semantics.

## Stop condition

Report merged server paths using the same decision logic and passing server unit tests.
