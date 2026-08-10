# React Adapter Primitive Matrix

- timestamp: 2026-06-28T06:24:05Z
- requirements: ADAPT-002, TEST-001
- status: complete for ADAPT-002

## Previous State

React had real hook/component conformance and a controller-backed hydration test, but the adapter verifier did not own a row-level matrix for SSR/hydration breadth, `asChild` ref/event composition, and StrictMode double invocation. Adding that matrix exposed a real StrictMode bug: the shared `useController` hook destroyed its controller during React's development-only StrictMode effect cleanup, then React reused the same ref with a destroyed controller.

## Final State

Added `uifn/react/src/__tests__/react-adapter-matrix.test.tsx`.

The matrix proves:

- SSR/hydration of a Dialog, Checkbox, Tabs, Select, Popover, and Tooltip component fixture without hydration warnings.
- Dialog `asChild` trigger ref forwarding and event composition.
- StrictMode double invocation behavior for controller-backed components.

Fixed `uifn/react/src/hooks/use-controller.ts` by deferring controller destruction one macrotask and cancelling the pending destroy if the effect is immediately remounted by StrictMode. This preserves real unmount cleanup while avoiding reuse of a destroyed controller during StrictMode's development pass.

`scripts/verify-uifn-adapter.mjs` now runs both `react-core-adapter.test.tsx` and `react-adapter-matrix.test.tsx` for React and emits both commands in release evidence.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run test -- src/__tests__/react-adapter-matrix.test.tsx`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run test -- src/__tests__/react-core-adapter.test.tsx`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework react`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

ADAPT-002 is complete. Svelte, Vue, and Solid adapter rows remain open. Live Storybook story-runner verification, styling closure, docs, security/privacy coverage, and source-install parity remain separate pending requirements.
