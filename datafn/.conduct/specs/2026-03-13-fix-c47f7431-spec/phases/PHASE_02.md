# PHASE_02

## Phase goal
Fix client search boundary behavior: canonical validation, option forwarding, and local-first routing with explicit source override.

## In scope / Out of scope
In scope:
- Client search payload validation for new options.
- Local and remote payload forwarding parity.
- Routing behavior for `source=auto|local|remote`.

Out of scope:
- Mutation lifecycle indexing.
- Plugin unification.

## Deliverables
- `datafn/client/src/client.ts`
- `datafn/client/__tests__/search.test.ts`
- `datafn/client/__tests__/search-routing.test.ts` (new if needed)

## Requirements covered
- CON-003
- CLI-001
- CLI-002
- CLI-003

## Implementation tasks
1. Add validation for `prefix`, `fuzzy`, and `fieldBoosts` in `client.search()`.
2. Add `source` parsing with default `auto` and canonical error handling.
3. Implement routing matrix: local-first in `auto`, explicit `local`, explicit `remote`.
4. Ensure option forwarding is unchanged through both local and remote branches.
5. Add tests for all path and validation combinations.

## Verification steps
1. `npm test --workspace @datafn/client -- --run search.test.ts`
Expected outcome: client search tests pass including forwarding assertions.
2. `npm test --workspace @datafn/client -- --run search-routing.test.ts`
Expected outcome: local-first and source override tests pass.

## Stop condition
Client search passes all validation, forwarding, and routing vectors including negative path checks.
