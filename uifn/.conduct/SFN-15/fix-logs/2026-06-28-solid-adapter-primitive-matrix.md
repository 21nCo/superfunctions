# Solid Adapter Primitive Matrix Closure

- timestamp: 2026-06-28T06:56:10Z
- requirements: ADAPT-005, TEST-001
- status: complete

## Previous State

Solid exposed public signal APIs and JSX components for Dialog, Checkbox, Tabs, Popover, Tooltip, Select, and Switch. `solid-core-adapter.test.tsx` proved shared conformance vectors, SSR rendering, and public signal prop getter reactivity, but the adapter row still lacked a verifier-owned browser/component matrix proving:

- all required primitive component families rendered and interacted together;
- conditional content mounted reactively after state changes;
- Checkbox ARIA/data attributes updated after clicks;
- canonical adapter context errors used `UIFnError` metadata instead of plain `Error`;
- Solid owner disposal unsubscribed controllers;
- hydrate-path markup remained controller-compatible after a user interaction.

## Production Changes

- Added `uifn/solid/src/__tests__/solid-adapter-matrix.test.tsx`.
- Added `uifn/solid/src/internal/context.ts` and exported it from `uifn/solid/src/index.ts`.
- Updated Dialog, Checkbox, Tabs, Popover, Tooltip, and Select component context helpers to throw `UIFN_ADAPTER_CONTEXT_MISSING` through `createUIFnError` with package `@uifn/solid`.
- Updated DialogContent, TabsContent, PopoverContent, TooltipContent, and SelectContent to use Solid `<Show>` so mounted content reacts to controller state.
- Updated CheckboxRoot to bind role, ARIA, disabled, value, data-state, and event handlers through reactive controller props.
- Updated `scripts/verify-uifn-adapter.mjs` so Solid requires the matrix file, canonical context helper, and both adapter test commands.

## Verification

- `PATH=<node22-bin>:$PATH npx vitest run --config uifn/solid/vitest.hooks.config.ts uifn/solid/src/__tests__/solid-adapter-matrix.test.tsx`
  - passed: 1 file, 4 tests.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run typecheck`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run test`
  - passed: 1 file, 7 tests.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run build`
  - passed including DTS output.
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework solid`
  - passed and executed `solid-core-adapter.test.tsx` plus `solid-adapter-matrix.test.tsx`.
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`
  - passed 81/81 with `adapter:solid` evidence listing both Solid adapter test commands.

## Remaining Work Outside This Row

ADAPT-005 is complete. The remaining SFN-15 work is in other rows: live Storybook story-runner verification, styling closure, docs/examples, clean-room provenance, source-install parity, security/privacy, and breaking-change cleanup.
