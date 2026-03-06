# PHASE 00

## Phase goal
Establish baseline contracts, fixtures, and config plumbing hooks for remaining fixes.

## In scope / Out of scope
In scope:
- Add config fields and baseline test harness updates.
- Add failing-first vector tests for all open findings.

Out of scope:
- Implementing endpoint/business logic changes.

## Deliverables
- `datafn/server/src/server.ts`
- `datafn/server/__tests__/security.test.ts`
- `datafn/server/__tests__/reliability-critical.test.ts`
- `datafn/server/__tests__/query-*.test.ts` (new/updated as needed)

## Requirements covered
- FIX-SEC-006
- FIX-SRV-003

## Implementation tasks
- [ ] Add `limits.maxBatchSize` and `limits.maxBatchQueryConcurrency` to server config type and defaults.
- [ ] Add baseline tests that assert defaults are applied.
- [ ] Add failing-first tests for vectors mapped in this phase.

## Verification steps
- `cd datafn/server && npm test -- security.test.ts reliability-critical.test.ts`
- Expected: New baseline tests run; behavior-change tests fail until later phases.

## Stop condition
Report merged config contracts and failing-first vector list before Phase 01.
