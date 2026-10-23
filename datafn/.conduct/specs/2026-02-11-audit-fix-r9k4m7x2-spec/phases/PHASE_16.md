# PHASE 16 — Bulk Mutation Fallback Strategy

## Phase Goal
Allow batch mutations to retry individual mutations when the batch fails as a whole.

## In Scope
- `fallbackToIndividual: true` option on batch mutations
- Individual retry via remote adapter for remote-first path
- Individual retry via offline handler for offline path
- Partial success result tracking

## Out of Scope
- Automatic retry count per individual mutation
- Priority ordering within the batch

## Deliverables
- `client/src/mutate.ts` — fallback logic for batch mutations
- `client/__tests__/mutate.test.ts` — fallback tests

## Requirements Covered
- BULK-001

## Implementation Tasks
1. Add `fallbackToIndividual?: boolean` to batch mutation options
2. When batch mutation fails and `fallbackToIndividual` is true:
   ```typescript
   if (fallbackToIndividual && isBatchFailure) {
     const results = [];
     for (const mutation of batchMutations) {
       try {
         const result = await remote.push({ clientId, mutations: [mutation] });
         results.push({ mutationId: mutation.mutationId, ok: true, result });
       } catch (err) {
         results.push({ mutationId: mutation.mutationId, ok: false, error: err });
       }
     }
     return aggregateResults(results);
   }
   ```
3. Aggregate result: `ok: true` only if all individual mutations succeeded
4. Return per-mutation errors in `errors` array
5. Write test: batch with 1 bad mutation, 4 good: 4 succeed, 1 fails
6. Write test: without fallbackToIndividual, entire batch fails
7. Write test: all mutations valid, batch succeeds normally (no fallback needed)
8. Run full test suite

## Verification Steps
- New tests pass: fallback, partial success, no-fallback
- `npm test -w @datafn/client` → 0 failures
- TV-BULK-001, TV-BULK-001N verified

## Stop Condition
Bulk mutation fallback works for partial batch failures. All tests pass. Phase report written.
