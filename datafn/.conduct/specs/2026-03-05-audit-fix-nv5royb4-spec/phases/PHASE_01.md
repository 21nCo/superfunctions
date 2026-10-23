# PHASE 01

## Phase goal
Implement uniform configurable batch-size enforcement for push and mutation endpoints.

## In scope / Out of scope
In scope:
- `maxBatchSize` enforcement on `/datafn/push` and `/datafn/mutation`.

Out of scope:
- Query batch concurrency behavior.

## Deliverables
- `datafn/server/src/routes/sync.ts`
- `datafn/server/src/routes/mutation.ts`
- `datafn/server/src/server.ts`
- Tests for TV-SEC-006-P1/N1/P2/N2

## Requirements covered
- FIX-SEC-006

## Implementation tasks
- [ ] Wire `maxBatchSize` through route handler opts.
- [ ] Replace hardcoded `500` in push handler with configured limit.
- [ ] Add mutation array-size guard using same configured limit.
- [ ] Ensure error envelopes include actual and max counts.

## Verification steps
- `cd datafn/server && npm test -- security.test.ts`
- Expected: TV-SEC-006 vectors pass.

## Stop condition
Both endpoints enforce identical configured cap behavior with passing vectors.
