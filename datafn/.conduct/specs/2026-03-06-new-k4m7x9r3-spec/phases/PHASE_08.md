# PHASE 08: Sync — Push Path & Change Tracking

## Phase goal
Ensure the push (sync) path handles new operations and injects capability fields consistently with the mutation route.

## In scope
- Push path accepts trash, restore, archive, unarchive operations
- Push path injects timestamps/audit fields on mutations
- Push validation accepts new operations
- Change tracking for new operations in push path

## Out of scope
- Share/unshare in push (Phase 10+)

## Deliverables
- `datafn/server/src/execution/sync/push.ts` (updated)
- `datafn/server/src/validation/mutation.ts` (updated — push validation for new ops)
- `datafn/server/src/execution/sync/__tests__/push-capabilities.test.ts` (new)

## Requirements covered
- SY-001, SY-002, SY-003

## Implementation tasks
1. In push execution, before processing each mutation, resolve capabilities for the resource
2. Apply `stripReadonlyCapabilityFields()` and inject capability fields (same as mutation route)
3. Pass actorId through push execution (extract from push context)
4. Add trash/restore/archive/unarchive cases to push operation switch
5. Update push validation to accept new operations
6. Ensure change tracking entries are recorded for all new operations
7. Write tests:
   - Push with insert on timestamps-enabled resource → createdAt/updatedAt set
   - Push with trash operation → record trashed, change tracked
   - Push with archive operation → record archived
   - Push with invalid operation → rejected

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/sync/__tests__/push-capabilities.test.ts` — all pass
2. `cd datafn/server && npx vitest run` — no regressions

## Stop condition
Push path handles all new operations with capability injection and change tracking.
