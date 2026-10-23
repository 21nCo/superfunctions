# React Component Renderables

- timestamp: 2026-06-28T04:13:40Z
- requirements: COMP-001, COMP-002, COMP-003, TEST-001
- scope: `@uifn/components`

## Previous State

The component package had an honesty gate for descriptor-only components, but React component exports had not been verified as real renderables. Existing Batch A and Batch B tests asserted metadata/descriptor output, and data-rich tests only exercised controller objects.

## Final State

React Batch A and Batch B exports now render real DOM through `React.forwardRef` components. The render path supports:

- stable root classes: `uifn-component`, `uifn-{slug}`, `uifn-{slug}--{variant}`, `uifn-size-{size}`;
- root data attributes: `data-uifn-component`, `data-uifn-part`, `data-variant`, `data-size`, `data-surface`, `data-surface-depth`, and state data flags;
- `unstyled`, consumer `className`, native props, disabled state, polymorphic `as`, and anatomy part overrides;
- void-element-safe rendering for form controls such as `Input`.

React data-rich exports now render semantic DOM shells:

- `DataTable` renders a native table with headers, body rows, and row ids.
- `Calendar` and `DatePicker` render grid roots.
- `Command` renders a listbox with options.
- `Resizable` and `Sidebar` render structural roots with component data attributes.

## Verification

Passed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`

Expected failure:

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-components.mjs`
- result: failed with 65 remaining failures covering shared descriptor factories, Svelte/Vue/Solid/Angular descriptor exports, and 45 component manifests still marked `implemented-contract`.

## Remaining Work

This is not a full component-layer completion. The next required work is to replace Svelte, Vue, Solid, and Angular component descriptor exports with framework-native renderables, remove shared descriptor factories, deepen component behavior tests, and only then update implementation manifests from `implemented-contract` to `implemented`.
