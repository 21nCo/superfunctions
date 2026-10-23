# Real Adapter Conformance: Angular

- timestamp: 2026-06-28T03:47:12Z
- requirements: ADAPT-001, ADAPT-006, TEST-001
- reference audits:
  - `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md`
  - `uifn/.conduct/audits/2026-06-28-m3v7q9xk-full-audit.md`

## Previous State

Angular conformance used `createMinimalFixtureAdapter`, which drove core controllers directly and bypassed the Angular directive/component API. The verifier could therefore pass without proving Angular inputs, outputs, part directives, or host-listener event translation.

## Implemented Change

- Replaced Angular conformance with a directive fixture adapter.
- Dialog vectors now instantiate:
  - `UifnDialogComponent`
  - `UifnDialogTriggerDirective`
  - `UifnDialogContentDirective`
  - `UifnDialogTitleDirective`
  - `UifnDialogDescriptionDirective`
  - `UifnDialogCloseDirective`
- Checkbox vectors now instantiate:
  - `UifnCheckboxComponent`
  - `UifnCheckboxRootDirective`
  - `UifnCheckboxIndicatorDirective`
  - `UifnCheckboxInputDirective`
- Added an explicit Checkbox directive/component behavior test with `checkedChange` emission and refreshed rendered part props.
- Hardened `scripts/verify-uifn-adapter.mjs` so Angular requires the real directive fixture, component classes, Checkbox evidence, and focused test execution.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run test -- src/__tests__/angular-core-adapter.test.ts`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework angular`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run build`
- `for fw in react svelte vue solid angular; do PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework "$fw" || exit 1; done`
- `rg -n "createMinimalFixtureAdapter" uifn/react/src/conformance uifn/svelte/src/conformance uifn/vue/src/conformance uifn/solid/src/conformance uifn/angular/src/conformance scripts/verify-uifn-adapter.mjs`

## Residual Risk

This fixes the conformance bypass for Angular. It does not complete ADAPT-006 because full primitive breadth and SSR/hydration evidence are still pending.
