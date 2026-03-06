# PHASE 11: Server — Shareable Query Gating & Mutation Authorization

## Phase goal
Enforce access control for shareable resources: queries only return accessible records, mutations check access levels.

## In scope
- Query gating for `private` shareable resources (filter by ownership + permissions)
- Mutation authorization based on access level (viewer/editor/owner)
- `getPermissions` query operation
- Integration with existing authz system

## Out of scope
- Client methods (Phase 12)

## Deliverables
- `datafn/server/src/execution/query/pushdown.ts` (updated — shareable query filter injection)
- `datafn/server/src/validation/authz.ts` (updated — access level checks)
- `datafn/server/src/execution/mutation/execute.ts` (updated — access level check before mutation)
- `datafn/server/src/routes/query.ts` (updated — getPermissions handler)
- `datafn/server/src/execution/mutation/__tests__/shareable-authz.test.ts` (new)

## Requirements covered
- SH-005, SH-006, SH-007

## Implementation tasks
1. Create `resolveAccessLevel(db, resource, recordId, actorId, namespace)` utility:
   - Check if actorId is the record's `createdBy` → return "owner"
   - Check permissions table for `(resourceId, actorId)` → return level
   - If no match → return null (no access)
2. For query gating on `private` shareable resources:
   - Before executing the query, inject a filter that joins with the permissions table
   - Implementation approach: add a subquery or post-filter that checks `createdBy = actorId OR EXISTS (permissions entry for actorId)`
   - If the DB adapter supports subqueries, use DB-level filtering
   - Otherwise, use application-level post-filtering (fetch records, then filter by access)
3. For mutation authorization on shareable resources:
   - Before executing any mutation, call `resolveAccessLevel()`
   - `viewer` → reject all mutations (FORBIDDEN)
   - `editor` → allow merge, replace, archive, trash, restore, unarchive; reject delete, share, unshare
   - `owner` → allow all operations
   - `null` (no access) → reject with FORBIDDEN
4. Implement `getPermissions` query:
   - New query type or route parameter
   - Queries `__datafn_permissions_{resource}` for a given `resourceId`
   - Only accessible to owners of the record
   - Returns `[{ userId, level, grantedBy, grantedAt }]`
5. Write tests:
   - Private resource: creator sees own records
   - Private resource: non-shared user sees nothing
   - Private resource: shared user sees shared records
   - Viewer cannot mutate
   - Editor can merge but not delete
   - Owner can do everything
   - getPermissions returns correct entries
   - getPermissions by non-owner → FORBIDDEN

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/shareable-authz.test.ts` — all pass
2. `cd datafn/server && npx vitest run` — no regressions

## Stop condition
Query gating enforces private access. Mutation authorization enforces access levels. getPermissions works.
