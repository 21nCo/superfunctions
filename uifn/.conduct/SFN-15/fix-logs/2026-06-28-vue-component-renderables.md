# Vue Component Renderables

- timestamp: 2026-06-28T04:39:34Z
- requirements: COMP-001, COMP-002, COMP-003, TEST-001
- scope: `@uifn/components/vue`

## Previous State

Vue component exports in Batch A, Batch B, and data-rich files were descriptor factory wrappers. They did not provide Vue-native renderable components and were correctly rejected by `verify:uifn-components`.

## Final State

Vue exports now use `defineComponent` with render functions for all 45 catalog entries.

Batch A and Batch B components render:

- stable `uifn-*` classes;
- `data-uifn-component`, `data-uifn-part`, variant, size, surface, surface-depth, and state data attributes;
- `unstyled`, `className`, native `class` attrs, native attrs, native element selection through `as`, disabled state, and anatomy part overrides.

Data-rich components render:

- native table structure for `DataTable`;
- grid roots for `Calendar` and `DatePicker`;
- listbox/options for `Command`;
- structural roots for `Resizable` and `Sidebar`.

The component package now includes Vue runtime tests with Vue Test Utils.

## Verification

Passed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`

Expected failure:

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-components.mjs`
- result: failed with 62 remaining failures for shared descriptor factories, Svelte/Solid/Angular descriptor exports, and 45 component manifests still marked `implemented-contract`.

## Remaining Work

Vue is now a real renderable framework slice, but the component layer is still incomplete until Svelte, Solid, and Angular exports are renderable, shared descriptor-only helpers are removed, stories/a11y/visual coverage is real, and registry manifests are honestly marked `implemented`.
