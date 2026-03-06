# PHASE 05

## Phase goal
Implement queued bounded-concurrency batch query execution.

## In scope / Out of scope
In scope:
- Queue/semaphore-based query batch executor.
- Config-driven concurrency cap.

Out of scope:
- Query route modular split.

## Deliverables
- `datafn/server/src/routes/query.ts` (or `routes/query/batch-executor.ts` if introduced early)
- `datafn/server/src/server.ts`
- Batch concurrency tests

## Requirements covered
- FIX-SRV-003

## Implementation tasks
- [ ] Add bounded runner for transformed query list.
- [ ] Replace direct `Promise.all` batch execution with bounded executor.
- [ ] Remove rejection based solely on batch length > concurrency.
- [ ] Add instrumentation test for max in-flight count.

## Verification steps
- `cd datafn/server && npm test -- validation/__tests__/validation.test.ts query*.test.ts`
- Expected: TV-SRV-003 vectors pass.

## Stop condition
Batch of N>concurrency succeeds; measured in-flight count never exceeds configured cap.
