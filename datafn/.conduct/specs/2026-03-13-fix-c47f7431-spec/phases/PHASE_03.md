# PHASE_03

## Phase goal
Complete client-side search index lifecycle by wiring local mutation success paths to `searchProvider.updateIndices`.

## In scope / Out of scope
In scope:
- Local mutation path index updates for supported operations.
- Debounced merge/local fallback path coverage.
- Fail-soft logging behavior for index update errors.

Out of scope:
- Server forwarding and route parsing.
- Plugin search candidate delegation.

## Deliverables
- `datafn/client/src/mutate.ts`
- `datafn/client/src/client.ts` (executeMutation parameter wiring)
- `datafn/client/__tests__/mutate.test.ts`
- `datafn/client/__tests__/search-rebuild.test.ts`
- `datafn/client/__tests__/search-index-mutation.test.ts` (new if needed)

## Requirements covered
- IDX-001
- IDX-002

## Implementation tasks
1. Add a client-side `tryUpdateSearchIndex` helper analogous to server behavior.
2. Invoke helper after successful local mutation paths (local-first, offline fallback, debounced local write).
3. Map mutation operations deterministically to `upsert` vs `delete`.
4. Ensure errors are logged and mutation success remains unaffected.
5. Add regression tests for success/failure and non-indexed operations.

## Verification steps
1. `npm test --workspace @datafn/client -- --run mutate.test.ts`
Expected outcome: mutation and event tests pass with new lifecycle assertions.
2. `npm test --workspace @datafn/client -- --run search-index-mutation.test.ts`
Expected outcome: index update operation mapping and fail-soft behavior pass.

## Stop condition
All local mutation paths covered by tests show fresh index updates without mutation regressions.
