# PHASE_08: Solid Adapter

## Phase Goal

Implement first-class Solid primitive support.

## In Scope

- Solid package.
- Signal-based headless APIs.
- JSX components.
- Context helpers.
- SSR tests.
- Conformance harness integration.

## Out of Scope

- Styled components beyond adapter fixtures.

## Deliverables

- `uifn/solid/src/index.ts`
- `uifn/solid/src/create-*.ts`
- `uifn/solid/src/components/*`
- `uifn/solid/src/conformance/*`
- `uifn/solid/src/__tests__/*`

## Requirements Covered

ADAPT-001, ADAPT-005

## Implementation Tasks

1. Add Solid peer dependencies and package metadata.
2. Implement signal-based wrappers around core controllers.
3. Implement JSX component APIs.
4. Add cleanup/disposal behavior.
5. Run shared conformance vectors.
6. Add SSR tests.

## Verification Steps

```bash
npm --workspace @uifn/solid run test
npm --workspace @uifn/solid run typecheck
npm run verify:uifn-adapter -- --framework solid
```

Expected outcome: Solid passes conformance and signal freshness checks.

## Stop Condition

Report Solid component API shape and any peer dependency constraints.

