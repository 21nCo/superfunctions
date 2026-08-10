# Solid Component Renderables

- timestamp: 2026-06-28T04:45:14Z
- requirements: COMP-001, COMP-002, COMP-003, TEST-001
- scope: `@uifn/components/solid`

## Previous State

Solid component exports in Batch A, Batch B, and data-rich files were descriptor factory wrappers. They did not provide Solid-native component functions and were correctly rejected by `verify:uifn-components`.

## Final State

Solid exports now provide component functions for all 45 catalog entries. The implementation uses Solid's `createComponent(Dynamic, ...)` runtime API directly rather than relying on a package-specific TSX compiler path.

Batch A and Batch B components render:

- stable `uifn-*` classes;
- `data-uifn-component`, `data-uifn-part`, variant, size, surface, surface-depth, and state data attributes;
- `unstyled`, native `class`, `className`, native attrs, native element selection through `as`, disabled state, and anatomy part overrides.

Data-rich components render:

- native table structure for `DataTable`;
- grid roots for `Calendar` and `DatePicker`;
- listbox/options for `Command`;
- structural roots for `Resizable` and `Sidebar`.

The component package now includes Solid browser DOM render tests using `solid-js/web` rendering.

## Verification

Passed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`

Expected failure:

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-components.mjs`
- result: failed with 59 remaining failures for shared descriptor factories, Svelte/Angular descriptor exports, and 45 component manifests still marked `implemented-contract`.

## Remaining Work

Solid is now a real renderable framework slice, but the component layer is still incomplete until Svelte and Angular exports are renderable, shared descriptor-only helpers are removed, stories/a11y/visual coverage is real, and registry manifests are honestly marked `implemented`.
