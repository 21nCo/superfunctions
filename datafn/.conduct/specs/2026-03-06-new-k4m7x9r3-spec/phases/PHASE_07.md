# PHASE 07: Client — Capability Methods

## Phase goal
Add `.trash()`, `.restore()`, `.archive()`, `.unarchive()` convenience methods to the client table API.

## In scope
- Client methods that send the corresponding DFQL operations
- Methods only available when the corresponding capability is enabled on the resource
- Query metadata support for `includeTrashed` and `includeArchived`
- Offline/local handling for new operations

## Out of scope
- Shareable client methods (Phase 12)
- Server execution (already done in Phases 4-6)

## Deliverables
- `datafn/client/src/mutate.ts` (updated — new operation methods)
- `datafn/client/src/query.ts` (updated — metadata passthrough)
- `datafn/client/src/__tests__/capability-methods.test.ts` (new)

## Requirements covered
- CL-001, CL-002, CL-003, CL-004, CL-008

## Implementation tasks
1. Add `.trash(id)` method to table/resource API:
   - Constructs `{ resource, operation: "trash", id }` mutation
   - Sends via existing mutation execution path
2. Add `.restore(id)` method — same pattern with `operation: "restore"`
3. Add `.archive(id)` method — `operation: "archive"`
4. Add `.unarchive(id)` method — `operation: "unarchive"`
5. Ensure `.delete(id)` continues to perform hard delete (no change)
6. Add `metadata` support to query API for `includeTrashed` and `includeArchived`
7. For offline mode: handle new operations in offline mutation path
   - Trash: update local record with `trashedAt`/`trashedBy` values
   - Restore: clear `trashedAt`/`trashedBy` locally
   - Archive/unarchive: update `isArchived` locally
8. Write tests:
   - `.trash()` sends correct DFQL operation
   - `.restore()` sends correct DFQL operation
   - `.archive()` sends correct DFQL operation
   - `.unarchive()` sends correct DFQL operation
   - `.delete()` still sends hard delete
   - Query with metadata passes through

## Verification steps
1. `cd datafn/client && npx vitest run` — all tests pass
2. `npx tsc --noEmit` — no type errors

## Stop condition
All four capability methods work and send correct operations. Existing delete unchanged.
