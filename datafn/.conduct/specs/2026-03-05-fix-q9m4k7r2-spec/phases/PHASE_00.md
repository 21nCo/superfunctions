# PHASE_00

## Phase goal

Enforce adapter-level zero-row update behavior so missing rows are never interpreted as success.

## In scope / Out of scope

- **In scope**:
  - Drizzle adapter `update()` missing-row behavior.
  - Adapter-level tests for update existing/missing.
- **Out of scope**:
  - Server merge flow changes.
  - Client KV logic changes.

## Deliverables

- `packages/db/src/adapters/drizzle/index.ts` (MODIFY)
- `packages/db/src/adapters/drizzle/drizzle.test.ts` (MODIFY)
- `packages/db/src/adapter/types.ts` (OPTIONAL comment clarification)

## Requirements covered

- ADP-001
- TST-001 (partial)

## Implementation tasks

- [ ] Update drizzle `update()` non-MySQL path to throw not-found when `returning()` yields no row.
- [ ] Keep existing return-shape for successful updates unchanged.
- [ ] Add drizzle tests for zero-row update not-found and existing-row update success.
- [ ] Validate namespace-wrapped behavior inherits thrown not-found.

## Verification steps

1. `npx vitest run packages/db/src/adapters/drizzle/drizzle.test.ts`
   - Expected: all drizzle adapter tests pass, including new missing-row update test.
2. `npx vitest run packages/db/src/adapter/__tests__/row-level-namespace.test.ts`
   - Expected: namespace wrapper tests pass with no regressions.

## Stop condition

Report passing adapter tests and confirm missing-row update now throws deterministic not-found.
