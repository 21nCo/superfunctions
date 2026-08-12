# Angular Component Renderables

- timestamp: 2026-06-28T04:49:59Z
- requirements: COMP-001, COMP-002, COMP-003, TEST-001
- scope: `@uifn/components/angular`

## Previous State

Angular component exports in Batch A, Batch B, and data-rich files were descriptor factory wrappers. They did not provide Angular component classes and were correctly rejected by `verify:uifn-components`.

## Final State

Angular exports now provide decorated standalone component classes for all 45 catalog entries.

Batch A and Batch B classes expose render metadata for:

- stable `uifn-*` classes;
- `data-uifn-component`, `data-uifn-part`, variant, size, surface, surface-depth, and state data attributes;
- `unstyled`, `className`, native element selection through `as`, disabled state, and anatomy part overrides.

Data-rich classes expose semantic render metadata for:

- table columns and rows for `DataTable`;
- grid roots for `Calendar` and `DatePicker`;
- listbox/options for `Command`;
- structural roots for `Resizable` and `Sidebar`.

The component package tests instantiate Angular component classes directly, matching the existing `@uifn/angular` adapter test style and avoiding forced JIT metadata access in Vitest.

## Verification

Passed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`

Expected failure:

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-components.mjs`
- result: failed with 56 remaining failures for shared descriptor factories, Svelte descriptor exports, and 45 component manifests still marked `implemented-contract`.

## Remaining Work

Angular is now a real renderable framework slice, but the component layer is still incomplete until Svelte exports are renderable, shared descriptor-only helpers are removed, stories/a11y/visual coverage is real, and registry manifests are honestly marked `implemented`.
