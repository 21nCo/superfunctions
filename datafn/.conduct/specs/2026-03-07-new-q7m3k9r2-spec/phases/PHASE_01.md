# PHASE 01

## Phase goal
Implement relation capability field definitions and collision enforcement in core schema processing.

## In scope
- Define relation capability field maps (`timestamps`, `audit`).
- Compute effective relation metadata field set including injected fields.
- Reject metadata collisions against injected relation capability fields.

## Out of scope
- Server execution path changes.
- Sync/change-tracking path changes.

## Deliverables
- `datafn/core/src/capabilities.ts` (extend or add relation helpers)
- `datafn/core/src/schema.ts`
- `datafn/core/src/index.ts` (exports)
- `datafn/core/src/__tests__/relation-capability-collision.test.ts` (new)

## Requirements covered
- RCAP-003
- RCAP-004

## Implementation tasks
1. Add relation capability-to-field mapping constants.
2. Add helper API for relation capability field derivation.
3. Wire collision detection for `relations[].metadata` against capability-injected relation field names.
4. Add tests for collisions and non-colliding metadata.
5. Ensure deterministic helper output ordering.

## Verification steps
1. `cd datafn/core && npx vitest run src/__tests__/relation-capability-collision.test.ts`
   - Expected: all tests pass.
2. `cd datafn/core && npx vitest run`
   - Expected: existing capability tests continue passing.

## Stop condition
Phase is complete when collision and helper behavior are covered with deterministic passing tests and no regressions in core capability suites.
