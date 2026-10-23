# PHASE 03

## Phase goal
Implement relation capability stripping and injection in relation mutation execution.

## In scope
- `relate` create/update paths for capability injection.
- `modifyRelation` update path for capability injection.
- Readonly relation capability field stripping.

## Out of scope
- Push route parity.
- Pull/clone/change-tracking verification.

## Deliverables
- `datafn/server/src/execution/mutation/relations.ts`
- `datafn/server/src/execution/mutation/execute.ts` (only if shared helpers are centralized)
- `datafn/server/src/execution/mutation/__tests__/relations-capabilities.test.ts` (new)

## Requirements covered
- JRT-001
- JRT-002
- JRT-003
- JRT-004
- SEC-001

## Implementation tasks
1. Add relation capability resolution at relation-execution call sites.
2. Implement stripping helper for readonly relation capability fields.
3. Implement create-path injection for relate upsert create payload.
4. Implement update-path injection for relate upsert update payload while preserving immutable fields.
5. Implement modifyRelation injection and retain `NOT_FOUND` behavior on missing row.
6. Add tests for actor fallback, stripping, and immutable field preservation.

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/relations-capabilities.test.ts`
   - Expected: all relation capability mutation tests pass.
2. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/relations.test.ts`
   - Expected: existing relation tests continue passing.

## Stop condition
Phase is complete when relation mutation execution enforces server-owned capability fields and passes both new and existing relation suites.
