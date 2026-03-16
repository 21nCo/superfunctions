# PHASE_07

## Phase goal
Implement actor-filtered sync semantics including revoke tombstones and grant backfill.

## In scope / Out of scope
In scope:
- Clone/pull/reconcile actor-visible filtering.
- Revoke tombstone emission.
- Grant backfill behavior.
- Actor-based permission/membership feed integration.

Out of scope:
- Relation inheritance graph behavior.

## Deliverables
- `datafn/server/src/execution/sync/clone.ts`
- `datafn/server/src/execution/sync/pull.ts`
- `datafn/server/src/execution/sync/reconcile.ts`
- `datafn/server/src/execution/sync/change-tracking.ts`
- `datafn/client/src/sync/apply.ts`
- `datafn/client/src/sync/engine.ts`
- `datafn/server/src/execution/sync/__tests__/spv2-sync-visibility.test.ts` (new)
- `datafn/client/__tests__/sync-spv2.test.ts` (new)

## Requirements covered
- AUTH-004
- SYNC-001
- SYNC-002
- SYNC-003
- SYNC-004

## Implementation tasks
1. Add access-filtering pipeline in clone/pull/reconcile.
2. Emit tombstones on visibility loss due to revoke/unshare/membership removal.
3. Add deterministic backfill mechanism for newly granted historical rows.
4. Integrate actor feed for permissions/membership/hierarchy changes.
5. Update client apply logic to consume revoke/backfill deterministically.
6. Add integration tests for offline lifecycle cases.

## Verification steps
1. `npm test --workspace datafn/server -- spv2-sync-visibility`
Expected outcome: server sync tests pass.
2. `npm test --workspace datafn/client -- sync-spv2`
Expected outcome: client sync tests pass.

## Stop condition
Offline client no longer leaks revoked data and reliably receives newly granted data.
