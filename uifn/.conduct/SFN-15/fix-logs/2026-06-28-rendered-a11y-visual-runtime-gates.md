# Rendered A11y And Visual Runtime Gates

- timestamp: 2026-06-28T05:42:08Z
- requirements: COMP-002, STORY-002, TEST-001, TEST-002
- changed files:
  - `scripts/verify-uifn-a11y.mjs`
  - `scripts/verify-uifn-visual.mjs`
  - `uifn/components/src/__tests__/story-runtime.test.ts`
  - `uifn/components/src/react/rendering.ts`
  - `uifn/components/src/vue/rendering.ts`
  - `uifn/components/src/solid/rendering.ts`
  - `uifn/components/src/svelte/StyledComponent.svelte`
  - `uifn/components/src/angular/rendering.ts`

## Previous State

The a11y and visual verifier scripts accepted metadata-only fixture/story flags. They did not render component output, so the release gate could still pass if component DOM, ARIA state attributes, or theme/viewport story rendering regressed.

The styled renderers also lacked explicit ARIA state output for disabled, invalid, and open states. The new runtime test exposed invalid React textarea/table output while it was being added.

## Final State

`@uifn/components` now includes a rendered runtime matrix test. It renders every one of the 45 component catalog entries across the React, Svelte, Vue, Solid, and Angular entry points.

The rendered a11y matrix checks:

- concrete `data-uifn-component` roots;
- root part/state data attributes;
- `aria-disabled`, `aria-invalid`, and `aria-expanded` for matching states;
- accessible names for native interactive roots;
- anatomy part presence;
- data-rich `table`, `grid`, and `listbox` roles;
- disabled command options.

The rendered visual matrix checks that all 45 components render nonblank roots across the light, dark, high-contrast-light, high-contrast-dark and mobile, tablet, desktop matrix, and rejects placeholder status markers in rendered output.

The production verifier scripts now execute the rendered matrix test:

- `verify-uifn-a11y.mjs --scope batch-b` runs the rendered a11y matrix.
- `verify-uifn-visual.mjs --scope data-rich` runs the rendered visual matrix.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test -- src/__tests__/story-runtime.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-a11y.mjs --scope batch-b`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-visual.mjs --scope data-rich`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-stories.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-components.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

This is stronger than JSON metadata validation, but it is still not the final TEST-002/STORY-002 state. Remaining work must add live browser Storybook execution, axe/WCAG assertions, keyboard focus traversal, and pixel snapshot comparison across the required themes, viewports, and framework surfaces.
