# PHASE_05: React Adapter

## Phase Goal

Rebuild `@uifn/react` on the core controller and adapter-kit contracts.

## In Scope

- Hook APIs.
- Compound component APIs.
- Headless prop getters.
- SSR/hydration tests.
- Conformance harness integration.

## Out of Scope

- Styled components.
- Pattern components.

## Deliverables

- `uifn/react/src/*`
- `uifn/react/src/hooks/*`
- `uifn/react/src/conformance/*`
- `uifn/react/src/__tests__/*`

## Requirements Covered

ADAPT-001, ADAPT-002, CORE-001, CORE-002

## Implementation Tasks

1. Implement React adapter wrappers for migrated core controllers.
2. Add hook APIs for all primitives.
3. Add compound components with idiomatic slot support.
4. Add SSR and hydration tests.
5. Run shared conformance vectors.
6. Remove React logic that duplicates core behavior where core coverage exists.

## Verification Steps

```bash
npm --workspace @uifn/react run test
npm --workspace @uifn/react run typecheck
npm run verify:uifn-adapter -- --framework react
```

Expected outcome: React passes conformance and SSR/hydration checks.

## Stop Condition

Report any primitive where React behavior still diverges from core vectors.

