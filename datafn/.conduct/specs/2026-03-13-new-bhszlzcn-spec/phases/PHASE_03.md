# PHASE_03

## Phase goal
Implement principal resolution and effective access resolver in server core.

## In scope / Out of scope
In scope:
- Direct membership lookup.
- Hierarchy expansion with cycle/depth guards.
- Cache and invalidation hooks.
- Effective level calculation (viewer/editor/owner precedence).

Out of scope:
- Endpoint integration.

## Deliverables
- `datafn/server/src/execution/auth/principal-resolver.ts` (new)
- `datafn/server/src/execution/auth/access-resolver.ts` (new)
- `datafn/server/src/execution/auth/cache.ts` (new)
- `datafn/server/src/execution/auth/__tests__/access-resolver.test.ts` (new)

## Requirements covered
- ARCH-006
- ARCH-005
- AUTH-006

## Implementation tasks
1. Implement direct membership and hierarchy traversal.
2. Add cycle detection and max-depth handling.
3. Implement effective level reduction across direct/scope/inherited grants.
4. Add cache invalidation hooks on hierarchy/membership writes.
5. Write deterministic resolver unit tests.

## Verification steps
1. `npm test --workspace datafn/server -- access-resolver`
Expected outcome: resolver tests pass.
2. `rg -n "cycle|maxDepth|effectiveLevel" datafn/server/src/execution/auth`
Expected outcome: guards and level logic present.

## Stop condition
Resolver returns deterministic principal sets and levels with passing cycle/depth tests.
