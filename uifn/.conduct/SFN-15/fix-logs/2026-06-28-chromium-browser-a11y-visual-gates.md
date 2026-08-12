# Chromium Browser A11y And Visual Gates

- timestamp: 2026-06-28T05:57:57Z
- requirements: COMP-002, COMP-003 partial, STORY-002 partial, TEST-001, TEST-002 partial
- changed files:
  - `uifn/components/src/__tests__/browser-workshop.test.ts`
  - `uifn/components/src/react/rendering.ts`
  - `uifn/components/src/vue/rendering.ts`
  - `uifn/components/src/solid/rendering.ts`
  - `uifn/components/src/svelte/DataRichComponent.svelte`
  - `uifn/components/src/angular/rendering.ts`
  - `uifn/components/package.json`
  - `package-lock.json`
  - `scripts/verify-uifn-a11y.mjs`
  - `scripts/verify-uifn-visual.mjs`

## Previous State

The a11y and visual release gates had rendered component evidence in jsdom, but no real browser execution. They did not run axe, keyboard traversal, browser screenshots, or pixel comparisons.

## Final State

`@uifn/components` now has a Chromium-backed browser workshop test.

The a11y browser gate:

- renders all 45 components across React, Svelte, Vue, Solid, and Angular;
- verifies 225 component roots in Chromium;
- injects `axe-core` and requires zero violations;
- performs keyboard Tab traversal and verifies the focused element is visible with focus outline.

The visual browser gate:

- captures Chromium screenshots across light, dark, high-contrast-light, high-contrast-dark themes;
- covers mobile, tablet, and desktop viewports;
- verifies screenshots are nonblank;
- uses `pixelmatch` to prove light and dark desktop snapshots materially differ.

The browser gate exposed and fixed real semantic issues:

- Calendar and DatePicker now render named grid roots with row/gridcell children.
- Command now renders a named listbox with selected and disabled option semantics.
- Browser story labels are unique for nav landmarks and explicit for button-root Svelte stories.

## Verification

- `PATH=<node22-bin>:$PATH npx playwright install chromium`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test -- src/__tests__/browser-workshop.test.ts`
- `PATH=<node22-bin>:$PATH npm install --package-lock-only --ignore-scripts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-a11y.mjs --scope batch-b`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-visual.mjs --scope data-rich`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-stories.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

This closes the no-browser/no-axe/no-pixel-gate gap for the component workshop path. It does not close live Storybook execution for every generated story entry. STORY-001 and STORY-002 remain in progress until the Storybook package itself runs stories in a browser.
