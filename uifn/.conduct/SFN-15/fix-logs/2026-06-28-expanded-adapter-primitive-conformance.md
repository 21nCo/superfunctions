# Expanded Adapter Primitive Conformance

- timestamp: 2026-06-28T03:58:37Z
- requirements: ADAPT-001, ADAPT-002, ADAPT-003, ADAPT-004, ADAPT-005, ADAPT-006, TEST-001
- reference audits:
  - `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md`
  - `uifn/.conduct/audits/2026-06-28-m3v7q9xk-full-audit.md`

## Previous State

Adapter conformance had been made real for Dialog and Checkbox, but the vector set was still narrow. Solid also lacked public headless/component APIs for Tabs, Popover, Tooltip, and Select. This meant the adapter layer could still appear healthy while large parts of the primitive surface were not exercised.

## Implemented Change

- Replaced the old narrow vector constant with `ADAPTER_KIT_PRIMITIVE_VECTORS`.
- Added conformance vectors for:
  - Dialog trigger open
  - Disabled Checkbox ignored interaction
  - Tabs trigger selection
  - Popover trigger open
  - Tooltip focus open
  - Select option selection
- Expanded React conformance to render public hooks for Dialog, Checkbox, Tabs, Popover, Tooltip, and Select.
- Expanded Svelte conformance to use public actions for Dialog, Checkbox, Tabs, Popover, Tooltip, and Select.
- Expanded Vue conformance to use public composables for Dialog, Checkbox, Tabs, Popover, Tooltip, and Select.
- Expanded Angular conformance to instantiate public components/directives for Dialog, Checkbox, Tabs, Popover, Tooltip, and Select.
- Added Solid signal APIs and JSX components for Tabs, Popover, Tooltip, and Select.
- Renamed the adapter-kit internal baseline fixture to `createCoreFixtureAdapter` and made framework conformance fail if it uses that core-only path.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/adapter-kit run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/adapter-kit run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/adapter-kit run build`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run test -- src/__tests__/react-core-adapter.test.tsx`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run test -- src/svelte-core-adapter.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run test -- src/__tests__/vue-core-adapter.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run test -- src/__tests__/solid-core-adapter.test.tsx`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run test -- src/__tests__/angular-core-adapter.test.ts`
- `for fw in react svelte vue solid angular; do PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework "$fw" || exit 1; done`
- `for pkg in @uifn/react @uifn/svelte @uifn/vue @uifn/solid @uifn/angular; do PATH=<node22-bin>:$PATH npm --workspace "$pkg" run typecheck || exit 1; done`
- `for pkg in @uifn/react @uifn/svelte @uifn/vue @uifn/solid @uifn/angular; do PATH=<node22-bin>:$PATH npm --workspace "$pkg" run build || exit 1; done`
- `rg -n "ADAPTER_KIT_MINIMAL_VECTORS|createMinimalFixtureAdapter|Minimal fixture" uifn/adapter-kit/src uifn/react/src/conformance uifn/svelte/src/conformance uifn/vue/src/conformance uifn/solid/src/conformance uifn/angular/src/conformance scripts/verify-uifn-adapter.mjs`

## Residual Risk

This closes the adapter conformance harness gap. The individual framework adapter requirements still need SSR/hydration, cleanup, and component ergonomics audited against their full spec rows.
