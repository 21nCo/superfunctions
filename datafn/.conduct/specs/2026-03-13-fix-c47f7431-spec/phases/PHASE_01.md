# PHASE_01

## Phase goal
Propagate search option contracts across core and server type surfaces to eliminate type-level option loss.

## In scope / Out of scope
In scope:
- Update SearchProvider contract fields in core and server.
- Extend server DFQL and cross-resource param types to represent new options.

Out of scope:
- Client runtime routing changes.
- Server route/execution runtime forwarding.

## Deliverables
- `datafn/core/src/search-provider.ts`
- `datafn/server/src/search-provider.ts`
- `datafn/server/src/execution/query/dfql.ts`
- `datafn/server/src/execution/search/cross-resource.ts` (type additions)

## Requirements covered
- CON-001
- CON-002

## Implementation tasks
1. Add `prefix`, `fuzzy`, `fieldBoosts` to `search` and `searchAll` signatures in both provider interfaces.
2. Add option fields to server DFQL search block type.
3. Add option fields to `CrossResourceSearchParams`.
4. Remove redundant `any` type casts that only existed because fields were missing in type definitions.

## Verification steps
1. `npm run typecheck --workspace @datafn/core`
Expected outcome: core package typecheck passes.
2. `npm run typecheck --workspace @datafn/server`
Expected outcome: server package typecheck passes.
3. `npm run typecheck --workspace @searchfn/datafn-provider`
Expected outcome: provider package typecheck passes with updated contract compatibility.

## Stop condition
All affected packages typecheck successfully with no contract drift between core/server SearchProvider interfaces.
