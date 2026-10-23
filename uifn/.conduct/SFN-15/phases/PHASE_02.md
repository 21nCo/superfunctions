# PHASE_02: Core Controller Contract

## Phase Goal

Implement the canonical `@uifn/core` behavior controller API and migrate existing primitives to it.

## In Scope

- Controller interfaces.
- Environment interface.
- Part prop getter shape.
- Deterministic ids.
- Initial primitive migrations.
- Core test vectors.

## Out of Scope

- Framework adapters beyond test fixtures.
- Styled components.

## Deliverables

- `uifn/core/src/controller.ts`
- `uifn/core/src/environment.ts`
- `uifn/core/src/parts.ts`
- `uifn/core/src/primitives/*`
- `uifn/core/src/__tests__/controller-contract.test.ts`
- `uifn/core/src/__tests__/primitive-vectors.test.ts`

## Requirements Covered

CORE-001, CORE-002, ARCH-002

## Implementation Tasks

1. Define `UIFnEnvironment`, `UIFnPartProps`, `UIFnPartController`, and `UIFnController`.
2. Add deterministic id and environment plumbing.
3. Add required accessibility prop merge behavior.
4. Migrate Dialog, Checkbox, Tabs, Select, Tooltip, and Popover as representative controllers.
5. Add a migration checklist for remaining controllers.
6. Add tests from `TV-CORE-001`, `TV-CORE-002`, and `TV-CORE-003`.

## Verification Steps

```bash
npm --workspace @uifn/core run test
npm --workspace @uifn/core run typecheck
```

Expected outcome: core vectors pass and no framework package is imported by `@uifn/core`.

## Stop Condition

Report primitives migrated and the remaining primitive migration list.
