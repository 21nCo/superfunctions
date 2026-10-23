# PHASE_04

## Phase goal
Fix server-side option loss by forwarding and validating search options across route and execution layers.

## In scope / Out of scope
In scope:
- Route-level extraction/validation of `prefix`, `fuzzy`, `fieldBoosts`.
- Per-resource and cross-resource execution forwarding.
- Query execution bridge forwarding to provider/native resolver paths.

Out of scope:
- Client plugin unification.
- Example app updates.

## Deliverables
- `datafn/server/src/routes/search.ts`
- `datafn/server/src/execution/query/search.ts`
- `datafn/server/src/execution/search/cross-resource.ts`
- `datafn/server/src/routes/query/execute.ts`
- `datafn/server/src/validation/query.ts`
- `datafn/server/src/execution/query/__tests__/search.test.ts`
- `datafn/server/src/execution/search/__tests__/cross-resource.test.ts`
- `datafn/server/src/routes/__tests__/search.test.ts`

## Requirements covered
- SRV-001
- SRV-002

## Implementation tasks
1. Extend route parser to read and validate new option fields.
2. Forward option fields to `executeCrossResourceSearch` and provider searchAll call.
3. Forward DFQL query search options to `searchProvider.search` in per-resource execution.
4. Ensure query validation accepts and validates search options inside `query.search` blocks.
5. Add regression tests covering positive/negative forwarding and validation paths.

## Verification steps
1. `npm test --workspace @datafn/server -- --run src/routes/__tests__/search.test.ts`
Expected outcome: route tests pass with new option assertions.
2. `npm test --workspace @datafn/server -- --run src/execution/query/__tests__/search.test.ts`
Expected outcome: per-resource forwarding tests pass.
3. `npm test --workspace @datafn/server -- --run src/execution/search/__tests__/cross-resource.test.ts`
Expected outcome: cross-resource forwarding tests pass.

## Stop condition
Server route and execution tests prove no option fields are dropped at any boundary.
