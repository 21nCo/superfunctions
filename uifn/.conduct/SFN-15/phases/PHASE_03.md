# PHASE_03: Adapter Kit and Conformance Harness

## Phase Goal

Build `@uifn/adapter-kit` utilities and shared conformance harness.

## In Scope

- Prop/event merge helpers.
- Ref/element registry helpers.
- Lifecycle cleanup.
- Focus and portal bridges.
- SSR guard.
- Conformance runner.

## Out of Scope

- Full adapter migrations.
- Styled components.

## Deliverables

- `uifn/adapter-kit/src/index.ts`
- `uifn/adapter-kit/src/merge-props.ts`
- `uifn/adapter-kit/src/refs.ts`
- `uifn/adapter-kit/src/lifecycle.ts`
- `uifn/adapter-kit/src/focus.ts`
- `uifn/adapter-kit/src/portal.ts`
- `uifn/adapter-kit/src/ssr.ts`
- `uifn/adapter-kit/src/conformance.ts`
- `uifn/adapter-kit/src/__tests__/*`

## Requirements Covered

ADAPT-001, CORE-002

## Implementation Tasks

1. Implement helper utilities listed in `FRAMEWORK_ADAPTERS.md`.
2. Define normalized conformance result JSON.
3. Add harness adapters for minimal fixture renderers.
4. Run Dialog and Checkbox vectors through the harness.
5. Add failure messages with primitive, framework, part, event, and vector id.

## Verification Steps

```bash
npm --workspace @uifn/adapter-kit run test
npm --workspace @uifn/adapter-kit run typecheck
```

Expected outcome: conformance harness can run at least two primitive vectors and report normalized failures.

## Stop Condition

Report conformance runner API and any framework-specific harness gaps.
