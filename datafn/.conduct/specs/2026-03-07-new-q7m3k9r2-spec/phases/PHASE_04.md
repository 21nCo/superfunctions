# PHASE 04

## Phase goal
Ensure sync pathways preserve relation capability semantics and payload parity.

## In scope
- Push route parity with direct mutation execution.
- Join-row change-tracking payload completeness.
- Pull and clone output verification for capability-enabled join rows.

## Out of scope
- Documentation updates.
- Example app schema adoption.

## Deliverables
- `datafn/server/src/execution/sync/push.ts` (if parity hooks needed)
- `datafn/server/src/execution/sync/change-tracking.ts` (if shape adjustments needed)
- `datafn/server/src/execution/sync/{pull,clone}.ts` (only if output mapping changes needed)
- `datafn/server/src/execution/sync/__tests__/push-relation-capabilities.test.ts` (new)
- `datafn/server/src/__tests__/integration/relation-capabilities-sync.test.ts` (new)

## Requirements covered
- JSY-001
- JSY-002
- COMP-001

## Implementation tasks
1. Reuse mutation relation helpers in push-executed relation mutations.
2. Ensure change records for join resources include injected relation capability fields.
3. Validate pull/clone serialization includes persisted join fields without ad-hoc filtering.
4. Add tests for capability-enabled and capability-disabled relation cases.

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/sync/__tests__/push-relation-capabilities.test.ts`
   - Expected: push parity tests pass.
2. `cd datafn/server && npx vitest run src/__tests__/integration/relation-capabilities-sync.test.ts`
   - Expected: pull/clone/change-tracking integration tests pass.

## Stop condition
Phase is complete when sync mutations, change entries, and downstream read paths are consistent for relation capability-enabled join rows.
