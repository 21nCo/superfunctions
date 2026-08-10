# PHASE_09: Angular Adapter

## Phase Goal

Implement first-class Angular primitive support with standalone directives first.

## In Scope

- Angular package.
- Standalone directives.
- Component wrappers.
- Two-way bindings.
- Context discovery.
- Conformance harness integration.

## Out of Scope

- Angular Material integration.
- Styled component theming beyond adapter fixtures.

## Deliverables

- `uifn/angular/src/index.ts`
- `uifn/angular/src/directives/*`
- `uifn/angular/src/components/*`
- `uifn/angular/src/conformance/*`
- `uifn/angular/src/__tests__/*`

## Requirements Covered

ADAPT-001, ADAPT-006

## Implementation Tasks

1. Add Angular peer dependencies and build config.
2. Implement root directives and part directives for migrated primitives.
3. Implement component wrappers for common usage.
4. Add typed inputs and outputs.
5. Add directive context validation.
6. Run shared conformance vectors.

## Verification Steps

```bash
npm --workspace @uifn/angular run test
npm --workspace @uifn/angular run typecheck
npm run verify:uifn-adapter -- --framework angular
```

Expected outcome: Angular passes directive conformance and two-way binding tests.

## Stop Condition

Report Angular directive naming conventions and any unsupported SSR checks.

