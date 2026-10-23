# PHASE 10: Server — Shareable Permissions Table Execution

## Phase goal
Implement `share` and `unshare` DFQL operations that manage the permissions join table.

## In scope
- New `share` operation: insert/upsert into `__datafn_permissions_{resource}`
- New `unshare` operation: delete from permissions table
- Validate shareable operations require `shareable` capability
- Validate `shareWith` payload structure
- Owner-only authorization for share/unshare
- Creator implicit owner logic
- Cascade delete permissions when record is hard-deleted
- Change tracking for share/unshare

## Out of scope
- Query gating (Phase 11)
- Client methods (Phase 12)

## Deliverables
- `datafn/server/src/execution/mutation/share.ts` (new — share/unshare execution logic)
- `datafn/server/src/execution/mutation/execute.ts` (updated — share/unshare cases)
- `datafn/server/src/execution/mutation/dfql.ts` (updated — share/unshare operations + shareWith type)
- `datafn/server/src/validation/mutation.ts` (updated — validate share/unshare)
- `datafn/server/src/execution/mutation/__tests__/share.test.ts` (new)

## Requirements covered
- SH-002, SH-003, SH-004, SH-008, SH-009, SH-010

## Implementation tasks
1. Add `"share"` and `"unshare"` to `MutationOperation` type
2. Extend `DFQLMutation` interface with optional `shareWith?: { userId: string; level?: string }`
3. In mutation validation, validate:
   - `share`/`unshare` require shareable capability
   - `share` requires `shareWith.userId` (string) and `shareWith.level` (must be in configured levels)
   - `unshare` requires `shareWith.userId`
4. Create `share.ts` with:
   - `executeShare(db, mutation, resolvedCapabilities, namespace, actorId)`:
     - Check actorId is owner (creator via `createdBy` or explicit owner permission)
     - If not owner → FORBIDDEN
     - Upsert into permissions table: `{ __ns, id: generateId(), resourceId, userId, level, grantedBy: actorId, grantedAt: Date.now() }`
     - Use unique constraint on `(resourceId, userId)` for upsert
   - `executeUnshare(db, mutation, resolvedCapabilities, namespace, actorId)`:
     - Check actorId is owner
     - If trying to unshare the creator → error "Cannot unshare the record creator"
     - Delete from permissions table where `resourceId = mutation.id AND userId = shareWith.userId`
     - Idempotent (no error if entry doesn't exist)
5. In `executeMutationCore()`, add share/unshare cases calling the new functions
6. Update delete case: when deleting a record on a shareable resource, also delete all permissions for that record
7. Verify trash does NOT cascade permissions (just hides the record)
8. Add change tracking for share/unshare operations
9. Write tests:
   - Share creates permissions entry
   - Re-share updates level (upsert)
   - Unshare removes entry
   - Unshare creator → error
   - Non-owner share → FORBIDDEN
   - Creator is implicit owner
   - Delete cascades permissions
   - Trash does not cascade permissions
   - Share on non-shareable resource → DFQL_UNSUPPORTED

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/share.test.ts` — all pass
2. `cd datafn/server && npx vitest run` — no regressions

## Stop condition
Share and unshare operations work correctly with ownership checks and cascading.
