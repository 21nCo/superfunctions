# Vue Adapter Primitive Matrix And Typed Context/Emits

- completed: 2026-06-28T06:44:54Z
- requirements: ADAPT-004, TEST-001
- reference audits: `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md`, `uifn/.conduct/audits/2026-06-28-m3v7q9xk-full-audit.md`

## Previous State

Vue conformance used real mounted composables, but `ADAPT-004` still lacked row-level proof that the public Vue component layer satisfied the SFN-15 adapter contract. Missing evidence covered full primitive component behavior, root scoped slots, typed emits, canonical provide/inject failures, and SSR/hydration.

Inspection also found concrete gaps:

- Dialog, Checkbox, Select, Popover, and Tooltip parts threw plain `Error` outside roots.
- Select value/item/indicator parts tolerated missing providers too loosely.
- Root components declared idiomatic change events, but the shared controllable helper emitted only `update:*`.
- Root components did not expose scoped slot props for state/actions.

## Final State

- Added `uifn/vue/src/__tests__/vue-adapter-matrix.test.ts`, covering Dialog, Checkbox, Tabs, Select, Popover, and Tooltip through public Vue component APIs.
- Matrix coverage includes root scoped slot props, interactive behavior, controlled rerenders, `update:*` and `*Change` emits, canonical provide/inject errors, SSR rendering, hydration, and post-hydration interaction.
- Replaced generic invalid-provider failures with `requireVueContext` and `UIFN_ADAPTER_PROVIDE_INJECT_MISSING`.
- Added root scoped slot props for primitive state/actions.
- Updated `useControllableState` to emit both `update:*` and `*Change`, and declared `pressedChange` for Toggle.
- Updated `scripts/verify-uifn-adapter.mjs` so Vue verification executes both:
  - `src/__tests__/vue-core-adapter.test.ts`
  - `src/__tests__/vue-adapter-matrix.test.ts`

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run test -- src/__tests__/vue-adapter-matrix.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework vue`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Release Evidence

The full release gate passed `81/81`. The `adapter:vue` release evidence now lists both Vue adapter test commands, including the new matrix test.

## Residual Risk

`ADAPT-004` is complete. Solid remains the only open framework adapter row. Storybook live runner coverage, styling completion, docs, privacy/security coverage, and source-install parity remain separate ledger rows.
