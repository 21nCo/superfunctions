# PHASE_04

## Phase goal
Integrate SPV2 into query path including shared-with-me mode and permission inspection.

## In scope / Out of scope
In scope:
- Add query metadata `accessMode` support.
- Implement shared-with-me cross-namespace join path.
- Extend getPermissions response for grant kinds.

Out of scope:
- Mutation/sync changes.

## Deliverables
- `datafn/server/src/routes/query.ts`
- `datafn/server/src/execution/query/execute.ts`
- `datafn/server/src/execution/query/pushdown.ts`
- `datafn/server/src/execution/query/__tests__/shared-with-me.test.ts` (new)

## Requirements covered
- API-003
- API-004
- ARCH-004

## Implementation tasks
1. Parse and validate `metadata.accessMode`.
2. Implement shared-with-me query planning against global permissions.
3. Keep namespace mode behavior unchanged.
4. Update getPermissions output to include `grantKind` and `sourceRef`.
5. Add integration tests for access mode and unauthorized filtering.

## Verification steps
1. `npm test --workspace datafn/server -- shared-with-me`
Expected outcome: new query mode tests pass.
2. Manual API check for `getPermissions` response shape.
Expected outcome: direct/scope/inherited grants represented.

## Stop condition
Query path supports both access modes and returns deterministic filtered results.
