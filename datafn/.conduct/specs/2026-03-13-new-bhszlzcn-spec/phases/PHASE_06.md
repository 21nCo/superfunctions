# PHASE_06

## Phase goal
Close endpoint parity gaps across actor propagation, push ACL, transact ACL, and relation expansion authz.

## In scope / Out of scope
In scope:
- Actor extraction wiring for all routes/executors.
- Push ACL parity with mutation path.
- Transact parity with non-transactional sequence.
- Relation expansion authorization enforcement.

Out of scope:
- Backfill/revoke sync behavior.

## Deliverables
- `datafn/server/src/server.ts`
- `datafn/server/src/routes/transact.ts`
- `datafn/server/src/execution/transact.ts`
- `datafn/server/src/routes/sync.ts`
- `datafn/server/src/execution/sync/push.ts`
- `datafn/server/src/validation/authz.ts`
- `datafn/server/src/execution/db-store.ts`
- `datafn/server/src/execution/query/select.ts`
- `datafn/server/src/__tests__/integration/spv2-parity.test.ts` (new)

## Requirements covered
- AUTH-001
- AUTH-002
- AUTH-003
- AUTH-005

## Implementation tasks
1. Ensure actor propagation for transact/clone/pull/reconcile paths.
2. Replace push-local ACL logic with shared access resolver.
3. Enforce same operation matrix in transact and push as mutation.
4. Add target-resource checks for relation expansion and nested selects.
5. Add parity integration tests for allow/deny outcomes.

## Verification steps
1. `npm test --workspace datafn/server -- spv2-parity`
Expected outcome: parity tests pass.
2. Manual check: same payload against `/mutation`, `/push`, `/transact` gives equivalent decisions.
Expected outcome: equivalent allow/deny + error code consistency.

## Stop condition
All parity vectors pass and known P0 endpoint drift issues are closed.
