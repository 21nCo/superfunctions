# PHASE 03

## Phase goal
Unify change-tracking retry behavior and make push mutation units atomic on transaction-capable adapters.

## In scope / Out of scope
In scope:
- Shared retry helper.
- Execute + push parity.
- Push mutation atomic unit semantics.

Out of scope:
- Whole-batch push transaction semantics.

## Deliverables
- `datafn/server/src/execution/mutation/execute.ts`
- `datafn/server/src/execution/sync/push.ts`
- `datafn/server/src/execution/sync/change-tracking.ts` (if helper location chosen)
- `datafn/server/__tests__/reliability-critical.test.ts`

## Requirements covered
- FIX-REL-002
- FIX-REL-011

## Implementation tasks
- [ ] Extract shared retry helper (2 retries; 50/100ms).
- [ ] Apply helper in execute mutation change-tracking path.
- [ ] Rework push to execute each mutation + change tracking in one transaction when supported.
- [ ] Preserve explicit fallback path for no-transaction adapters with warning logs.

## Verification steps
- `cd datafn/server && npm test -- reliability-critical.test.ts concurrent.test.ts`
- Expected: TV-REL-002 and TV-REL-011 vectors pass.

## Stop condition
No transaction-capable path can commit mutation data without corresponding change entry.
