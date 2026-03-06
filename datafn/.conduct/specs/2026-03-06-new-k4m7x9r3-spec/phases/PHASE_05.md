# PHASE 05: Server — Archive & Unarchive Operations

## Phase goal
Implement the `archive` and `unarchive` DFQL operations on the server.

## In scope
- New `archive` operation: sets `isArchived: true`
- New `unarchive` operation: sets `isArchived: false`
- Validate operations require `archivable` capability
- `isArchived` also settable via direct merge
- Change tracking

## Out of scope
- Query auto-filtering (Phase 6)
- Client methods (Phase 7)

## Deliverables
- `datafn/server/src/execution/mutation/execute.ts` (updated — archive/unarchive cases)
- `datafn/server/src/execution/mutation/dfql.ts` (updated — MutationOperation type)
- `datafn/server/src/validation/mutation.ts` (updated)
- `datafn/server/src/execution/mutation/__tests__/archive.test.ts` (new)

## Requirements covered
- AR-001, AR-002, AR-003, AR-006, AR-007, VA-002

## Implementation tasks
1. Add `"archive"` and `"unarchive"` to `MutationOperation` type
2. Add to `VALID_OPERATIONS` set
3. Validate archive/unarchive require `archivable` capability
4. Implement archive case: `db.update()` with `{ isArchived: true }` + timestamps/audit injection
5. Implement unarchive case: `db.update()` with `{ isArchived: false }` + timestamps/audit injection
6. Ensure `isArchived` is NOT stripped from merge records (it's client-writable)
7. Change tracking for archive/unarchive
8. Write tests:
   - Archive sets isArchived: true
   - Unarchive sets isArchived: false
   - Archive on non-archivable → DFQL_UNSUPPORTED
   - Direct merge with isArchived: true works
   - Change tracking entries

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/archive.test.ts` — all pass
2. `cd datafn/server && npx vitest run` — no regressions

## Stop condition
Archive and unarchive operations execute correctly and are tracked.
