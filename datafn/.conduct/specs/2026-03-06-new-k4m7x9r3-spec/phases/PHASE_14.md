# PHASE 14: Example App Update & Integration Test

## Phase goal
Update the todo-app example to use capabilities and create an end-to-end integration test.

## In scope
- Update todo-app schema to use `capabilities` instead of manual system field definitions
- Regenerate Drizzle schema with new codegen
- Verify the app works end-to-end with capabilities
- Add integration test covering the full capability lifecycle

## Out of scope
- Shareable in the example app (would require multi-user setup)

## Deliverables
- `datafn/examples/todo-app/server/src/schema.datafn.ts` (updated)
- `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts` (regenerated)
- `datafn/server/src/__tests__/integration/capabilities-e2e.test.ts` (new)

## Requirements covered
- All requirements verified end-to-end

## Implementation tasks
1. Update `schema.datafn.ts`:
   - Add `capabilities: ["timestamps", "audit"]` at schema level
   - Add `capabilities: ["trash", "archivable"]` on todos resource
   - Remove manual `createdAt` and `updatedAt` field definitions from todos and categories
2. Regenerate Drizzle schema using CLI codegen
3. Verify generated schema has correct capability columns
4. Create integration test:
   - Insert a todo → verify createdAt, updatedAt, createdBy, updatedBy auto-set
   - Merge the todo → verify updatedAt changed, createdAt unchanged
   - Trash the todo → verify excluded from queries
   - Query with includeTrashed → verify visible
   - Restore the todo → verify visible in default queries
   - Archive the todo → verify excluded
   - Query with includeArchived → verify visible
   - Unarchive → verify visible
   - Delete → verify permanently removed
5. Run existing example app tests to verify no regressions

## Verification steps
1. `cd datafn/server && npx vitest run src/__tests__/integration/capabilities-e2e.test.ts` — all pass
2. Example app builds and starts without errors
3. All existing tests continue to pass

## Stop condition
Example app uses capabilities. Integration test covers full lifecycle. No regressions.
