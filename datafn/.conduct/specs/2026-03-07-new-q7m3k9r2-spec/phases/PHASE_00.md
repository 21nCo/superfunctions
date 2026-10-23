# PHASE 00

## Phase goal
Define and lock the relation capability schema contract and validation error behavior.

## In scope
- Add relation capability type surface on `DatafnRelationSchema`.
- Validate structure and allowed values for relation capabilities.
- Enforce `many-many`-only constraint and deterministic error mapping.

## Out of scope
- Runtime mutation field injection.
- CLI codegen changes.
- Sync behavior changes.

## Deliverables
- `datafn/core/src/types.ts`
- `datafn/core/src/schema.ts`
- `datafn/core/src/__tests__/schema-capabilities-relation.test.ts` (new)

## Requirements covered
- RCAP-001
- RCAP-002
- RCAP-004

## Implementation tasks
1. Add relation capability type definitions and `relations[].capabilities` schema field.
2. Add validation rules for relation capability type/value constraints.
3. Enforce non-many-many rejection with deterministic error code/path.
4. Implement deterministic relation capability canonical ordering and dedupe.
5. Add tests for valid, invalid, and deterministic resolution cases.

## Verification steps
1. `cd datafn/core && npx vitest run src/__tests__/schema-capabilities-relation.test.ts`
   - Expected: all tests pass.
2. `cd datafn/core && npx tsc --noEmit`
   - Expected: no type errors.

## Stop condition
Phase is complete when relation capability declarations validate deterministically and invalid declarations fail with expected error codes/paths.
