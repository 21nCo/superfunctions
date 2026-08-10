# PHASE_06: Svelte Adapter

## Phase Goal

Rebuild `@uifn/svelte` on the core controller and adapter-kit contracts.

## In Scope

- Svelte components.
- Headless actions.
- Snippet/slot APIs.
- Context errors.
- SSR/hydration tests.
- Conformance harness integration.

## Out of Scope

- Styled components.
- Product-specific compatibility wrappers.

## Deliverables

- `uifn/svelte/src/*`
- `uifn/svelte/src/actions/*`
- `uifn/svelte/src/internal/*`
- `uifn/svelte/src/conformance/*`
- `uifn/svelte/src/*.test.ts`

## Requirements Covered

ADAPT-001, ADAPT-003, CORE-001, CORE-002

## Implementation Tasks

1. Implement Svelte root/part components using core controllers.
2. Implement headless actions for custom markup.
3. Add context validation errors.
4. Add Svelte 5 compatibility coverage.
5. Run shared conformance vectors.
6. Remove legacy adapter-only behavior drift.

## Verification Steps

```bash
npm --workspace @uifn/svelte run test
npm --workspace @uifn/svelte run typecheck
npm run verify:uifn-adapter -- --framework svelte
```

Expected outcome: Svelte passes conformance, Svelte 5, SSR, and hydration checks.

## Stop Condition

Report primitives complete and any Svelte-specific API decisions.
