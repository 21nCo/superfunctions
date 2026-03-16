# PHASE_08

## Phase goal
Implement relation inheritance lifecycle and consent-aware relate semantics.

## In scope / Out of scope
In scope:
- Parent-proxy inheritance grant evaluation.
- Inherited grant revoke propagation.
- Consent and permission checks for relate operations.

Out of scope:
- Benchmarks and performance tuning.

## Deliverables
- `datafn/server/src/execution/relations/inheritance.ts` (new)
- `datafn/server/src/execution/mutation/execute.ts`
- `datafn/server/src/execution/mutation/__tests__/relation-inheritance-spv2.test.ts` (new)
- `datafn/server/src/execution/query/__tests__/relation-inheritance-query.test.ts` (new)

## Requirements covered
- REL-001
- REL-002
- USE-001

## Implementation tasks
1. Implement inheritance evaluation path in access resolver.
2. Wire inheritance updates into relate/unrelate/share/unshare mutation outcomes.
3. Enforce consent requirement when configured.
4. Add tests for collection/habit/account/objective patterns.

## Verification steps
1. `npm test --workspace datafn/server -- relation-inheritance-spv2`
Expected outcome: inheritance tests pass.
2. Manual scenario replay: share parent -> add child -> revoke parent.
Expected outcome: child visibility follows parent lifecycle.

## Stop condition
Relation inheritance works with deterministic grant/revoke behavior and consent enforcement.
