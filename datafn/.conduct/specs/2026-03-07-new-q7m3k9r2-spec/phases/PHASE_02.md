# PHASE 02

## Phase goal
Make generated DB schema and TypeScript types reflect relation capability fields.

## In scope
- Drizzle codegen join-table capability columns.
- Type codegen join-table interfaces for capability-enabled relations.
- Deterministic output ordering preserved.

## Out of scope
- Server mutation behavior.
- Sync runtime.

## Deliverables
- `datafn/cli/src/drizzle-codegen.ts`
- `datafn/cli/src/codegen.ts`
- `datafn/cli/src/__tests__/drizzle-codegen-relation-capabilities.test.ts` (new)
- `datafn/cli/src/__tests__/codegen-relation-capabilities.test.ts` (new)

## Requirements covered
- JCG-001
- JCG-002
- COMP-001

## Implementation tasks
1. Resolve relation capabilities for each many-many relation during join-table generation.
2. Inject join-table columns for relation capability fields with correct dialect mapping.
3. Preserve existing join-table defaults when capabilities are absent.
4. Update type codegen to emit join interfaces when metadata exists OR relation capabilities exist.
5. Add deterministic snapshot tests for capability-enabled and non-enabled relations.

## Verification steps
1. `cd datafn/cli && npx vitest run src/__tests__/drizzle-codegen-relation-capabilities.test.ts`
   - Expected: snapshot and behavior tests pass.
2. `cd datafn/cli && npx vitest run src/__tests__/codegen-relation-capabilities.test.ts`
   - Expected: interface emission behavior passes.
3. `cd datafn/cli && npx tsc --noEmit`
   - Expected: no type errors.

## Stop condition
Phase is complete when codegen output includes relation capability fields only for opted-in relations and stays unchanged for non-opt-in relations.
