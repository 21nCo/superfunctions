# PHASE 06 — Silent Mutations and System Mutation Flag

## Phase Goal
Add `silent` and `system` options to mutations for internal/bulk operation control.

## In Scope
- `silent: true` — suppress event emission and signal refresh
- `system: true` — propagate flag in event payload
- Both options in mutation path (local-first, remote, offline fallback)

## Out of Scope
- Auto-stamping behavior (that's a plugin/Nucleus concern)
- Batch-level silent flag (each mutation in a batch can be individually silent)

## Deliverables
- `client/src/mutate.ts` — silent + system flag handling
- `client/__tests__/mutate.test.ts` — new tests

## Requirements Covered
- MUT-001, MUT-002

## Implementation Tasks
1. Add `silent?: boolean` and `system?: boolean` to mutation options type
2. In `emitMutationEvents()`:
   - If `silent: true`, skip event emission entirely (return early)
   - If `system: true`, include `system: true` in event payload
3. Ensure `silent: true` mutations still:
   - Apply to local storage
   - Append to changelog
   - Are picked up by push
4. Ensure `silent: true` does NOT:
   - Emit `mutation_applied` or `mutation_rejected`
   - Trigger signal refresh
5. For batch mutations, check `silent` per mutation (not batch-level)
6. Write test: silent mutation applies to storage and changelog
7. Write test: silent mutation does NOT emit events
8. Write test: non-silent mutation emits events (backward compat)
9. Write test: system mutation includes flag in event
10. Write test: non-system mutation does not include flag
11. Write test: silent + system combined works correctly
12. Run full test suite

## Verification Steps
- New tests pass: silent, system, combined
- `npm test -w @datafn/client` → 0 failures
- TV-MUT-001, TV-MUT-001N, TV-MUT-002, TV-MUT-002N verified

## Stop Condition
Silent and system mutation flags work correctly. All tests pass. Phase report written.
