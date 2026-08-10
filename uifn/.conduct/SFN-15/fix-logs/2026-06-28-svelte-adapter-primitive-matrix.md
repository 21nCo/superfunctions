# Svelte Adapter Primitive Matrix And Cleanup Fixes

- completed: 2026-06-28T06:36:33Z
- requirements: ADAPT-003, TEST-001
- reference audits: `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md`, `uifn/.conduct/audits/2026-06-28-m3v7q9xk-full-audit.md`

## Previous State

Svelte conformance used real public action APIs, but `ADAPT-003` still lacked one verifier-owned proof that the public Svelte component surface met the SFN-15 adapter contract. The missing evidence covered component/action parity, Svelte 5 snippet/runes compatibility, controlled rerenders, canonical context errors, action cleanup, and SSR/hydration behavior.

Inspection also found concrete adapter issues:

- `CheckboxIndicator`, `TooltipTrigger`, and `TooltipContent` used raw `getContext`, producing non-canonical failures outside roots.
- `SelectItem` teardown removed only the option element, not the option state, and could leave selected values stale while options were removed.
- `Combobox` assumed `scrollIntoView` exists in all hosts.
- Several Svelte 5 `bind:this` refs and `VirtualizedListTest` item derivation emitted compiler compatibility warnings.

## Final State

- Added `uifn/svelte/src/testing/SvelteAdapterMatrixTest.svelte`, a Svelte 5 consumer-style fixture for Dialog, Checkbox, Tabs, Select, Popover, and Tooltip.
- Added `uifn/svelte/src/svelte-adapter-matrix.test.ts`, covering component rendering, component interactions, controlled rerenders, canonical context errors, action cleanup, server compilation, and hydration.
- Updated `scripts/verify-uifn-adapter.mjs` so Svelte verification executes:
  - `src/svelte-core-adapter.test.ts`
  - `src/controlled-reactivity.test.ts`
  - `src/svelte-adapter-matrix.test.ts`
- Replaced raw context reads in Checkbox/Tooltip primitive parts with `getRequiredContext`.
- Fixed Select option teardown to remove option state and clear stale selected values safely.
- Guarded Combobox `scrollIntoView` for non-browser/jsdom hosts.
- Converted warned `bind:this` refs and the virtualized-list test fixture to Svelte 5 reactive state/derivations.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run test -- src/svelte-adapter-matrix.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework svelte`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Release Evidence

The full release gate passed `81/81`. The `adapter:svelte` release evidence now lists all three Svelte adapter test commands, including the new matrix test.

## Residual Risk

`ADAPT-003` is complete. Vue and Solid adapter rows remain open. Storybook live runner coverage, styling completion, docs, privacy/security coverage, and source-install parity remain separate ledger rows.
