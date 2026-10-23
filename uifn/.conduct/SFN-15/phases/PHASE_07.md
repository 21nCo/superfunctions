# PHASE_07: Vue Adapter

## Phase Goal

Promote `@uifn/vue` from experimental to first-class SFN-15 adapter.

## In Scope

- Vue composables.
- Root/part components.
- Provide/inject context.
- Scoped slots.
- SSR/hydration tests.
- Conformance harness integration.

## Out of Scope

- Styled components.

## Deliverables

- `uifn/vue/src/*`
- `uifn/vue/src/composables/*`
- `uifn/vue/src/conformance/*`
- `uifn/vue/src/__tests__/*`

## Requirements Covered

ADAPT-001, ADAPT-004

## Implementation Tasks

1. Normalize Vue package status and README.
2. Implement composable APIs for every primitive.
3. Implement component APIs with typed props and emits.
4. Add provide/inject validation.
5. Run shared conformance vectors.
6. Add SSR/hydration coverage.

## Verification Steps

```bash
npm --workspace @uifn/vue run test
npm --workspace @uifn/vue run typecheck
npm run verify:uifn-adapter -- --framework vue
```

Expected outcome: Vue passes conformance and no longer claims experimental status.

## Stop Condition

Report Vue API parity and any intentional Vue-only syntax differences.
