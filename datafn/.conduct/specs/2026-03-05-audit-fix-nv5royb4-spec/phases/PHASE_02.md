# PHASE 02

## Phase goal
Close remaining prototype-pollution entry points in query validation.

## In scope / Out of scope
In scope:
- Query-level, aggregations, and having pollution checks.

Out of scope:
- Unrelated validation semantics.

## Deliverables
- `datafn/server/src/validation/query.ts`
- `datafn/server/src/validation/__tests__/validation.test.ts`
- `datafn/server/__tests__/security-critical.test.ts`

## Requirements covered
- FIX-SEC-008

## Implementation tasks
- [ ] Add top-level query pollution guard.
- [ ] Add recursive pollution guard for aggregations object.
- [ ] Add recursive pollution guard for having object.
- [ ] Keep error shape/message parity with existing mutation/filter checks.

## Verification steps
- `cd datafn/server && npm test -- security-critical.test.ts validation/__tests__/validation.test.ts`
- Expected: TV-SEC-008 vectors pass.

## Stop condition
All SEC-008 vectors pass and no legacy path bypasses pollution checks.
