# Angular Adapter Primitive Matrix

- timestamp: 2026-06-28T06:18:12Z
- requirements: ADAPT-006, TEST-001
- status: complete for ADAPT-006

## Previous State

Angular exposed standalone directives and component wrappers, and `angular-core-adapter.test.ts` covered Dialog/Checkbox two-way behavior. Tabs, Select, Popover, and Tooltip behavior was still mostly indirect through the conformance harness and source-token checks. The adapter verifier did not name the exact tests it executed in release evidence.

## Final State

Added `uifn/angular/src/__tests__/angular-adapter-matrix.test.ts`.

The matrix directly instantiates component wrappers and standalone directives for:

- Tabs: value output, trigger/content rendered attrs, active state.
- Select: option registration, open/value outputs, listbox/option attrs, close-on-select.
- Popover: trigger/close outputs, content attrs, hidden/open state.
- Tooltip: focus/blur outputs, describedby wiring, tooltip attrs.

It also proves directive context errors for every remaining Angular part family and Node/server-safe direct class instantiation without `window`, matching the current no-JIT Angular package test setup.

`scripts/verify-uifn-adapter.mjs` now supports multiple adapter test commands and emits the executed test commands in release evidence. For Angular it runs both the core adapter test and the primitive matrix test.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run test -- src/__tests__/angular-adapter-matrix.test.ts`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework angular`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

ADAPT-006 is complete under the requirement caveat that Angular SSR/hydration is required where the local Angular test setup supports it. React, Svelte, Vue, and Solid adapter rows remain open. Live Storybook story-runner verification, styling closure, docs, security/privacy coverage, and source-install parity remain separate pending requirements.
