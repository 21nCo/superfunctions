# PHASE 14 — Soft-Delete Plugin

## Phase Goal
Provide a configurable soft-delete plugin that converts delete mutations to merge operations and auto-filters deleted records.

## In Scope
- `createSoftDeletePlugin(config)` factory
- Delete → merge conversion (`isDeleted`, `deletedAt`)
- Auto-filter on queries (`isDeleted: { $ne: true }`)
- `restore(id)` convenience via merge
- Per-resource configuration

## Out of Scope
- Archive/unarchive (application-level concern)
- Cascade soft-delete to related records (application-level)
- Schema auto-modification (caller must declare isDeleted/deletedAt fields)

## Deliverables
- `client/src/plugins/softDelete.ts` — soft-delete plugin (NEW FILE)
- `client/__tests__/plugins/softDelete.test.ts` — plugin tests

## Requirements Covered
- SD-001

## Implementation Tasks
1. Define plugin config type:
   ```typescript
   interface SoftDeleteConfig {
     resources: string[]; // Resources that use soft-delete
     deletedAtField?: string; // Default: "deletedAt"
     isDeletedField?: string; // Default: "isDeleted"
   }
   ```
2. Implement `createSoftDeletePlugin(config)`:
   - `beforeMutation` hook:
     - If mutation is `delete` on a configured resource:
       - Convert to `merge` with `{ [isDeletedField]: true, [deletedAtField]: new Date() }`
     - Pass through all other mutations
   - `beforeQuery` hook:
     - If query targets a configured resource and no `includeDeleted` metadata:
       - Add `{ [isDeletedField]: { $ne: true } }` to filters (using $and to combine with existing)
     - If `includeDeleted: true` in query metadata, skip filter injection
3. Implement `restore(table, id)` as a utility:
   ```typescript
   await table.mutate({ operation: "merge", id, record: { [isDeletedField]: false, [deletedAtField]: null } });
   ```
4. Plugin `runsOn: ["client"]` (server-side version is optional but can use same logic)
5. Write test: delete mutation becomes merge with isDeleted fields
6. Write test: query auto-filters soft-deleted records
7. Write test: query with includeDeleted includes soft-deleted
8. Write test: restore clears isDeleted/deletedAt
9. Write test: non-configured resources unaffected
10. Run full test suite

## Verification Steps
- New tests pass: soft-delete, auto-filter, restore
- `npm test -w @datafn/client` → 0 failures
- TV-SD-001, TV-SD-001N verified

## Stop Condition
Soft-delete plugin works correctly. All tests pass. Phase report written.
