# PHASE 04: Server — Trash & Restore Operations

## Phase goal
Implement the `trash` and `restore` DFQL operations on the server.

## In scope
- New `trash` operation: sets `trashedAt` and `trashedBy`
- New `restore` operation: clears `trashedAt` and `trashedBy`
- Validate that trash/restore operations are only allowed on resources with `trash` capability
- Idempotent behavior (trash already-trashed, restore non-trashed)
- Change tracking for trash/restore

## Out of scope
- Query auto-filtering (Phase 6)
- Client methods (Phase 7)

## Deliverables
- `datafn/server/src/execution/mutation/execute.ts` (updated — trash/restore cases)
- `datafn/server/src/execution/mutation/dfql.ts` (updated — MutationOperation type)
- `datafn/server/src/validation/mutation.ts` (updated — accept trash/restore)
- `datafn/server/src/execution/mutation/__tests__/trash-restore.test.ts` (new)

## Requirements covered
- TR-001, TR-002, TR-003, TR-006, TR-007, TR-008, VA-002

## Implementation tasks
1. Add `"trash"` and `"restore"` to `MutationOperation` type in dfql.ts
2. Add `"trash"` and `"restore"` to `VALID_OPERATIONS` in execute.ts
3. In mutation validation (`validateMutation`), add trash/restore to valid operations. When these operations are used, validate that the resource has the `trash` capability (requires passing resolved capabilities or schema to validation)
4. Implement trash case in `executeMutationCore()`:
   - Find existing record
   - If not found, return NOT_FOUND error
   - Call `db.update()` with `{ trashedAt: Date.now(), trashedBy: actorId ?? null }`
   - Also inject timestamps/audit updates if those capabilities are enabled
   - Return ok
5. Implement restore case in `executeMutationCore()`:
   - Find existing record
   - If not found, return NOT_FOUND error
   - If not trashed (`trashedAt` is null), return ok (idempotent)
   - Call `db.update()` with `{ trashedAt: null, trashedBy: null }`
   - Also inject timestamps/audit updates
   - Return ok
6. Add change tracking for trash/restore operations (record the full record state)
7. Write tests:
   - Trash sets trashedAt and trashedBy
   - Restore clears trashedAt and trashedBy
   - Trash on non-trash resource → DFQL_UNSUPPORTED
   - Restore on non-trash resource → DFQL_UNSUPPORTED
   - Double trash is idempotent
   - Restore non-trashed is idempotent
   - Hard delete on trashed record succeeds
   - Change tracking entries recorded

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/trash-restore.test.ts` — all pass
2. `cd datafn/server && npx vitest run` — no regressions

## Stop condition
Trash and restore operations execute correctly, are validated, and tracked.
