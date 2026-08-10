# Production component catalog fix log

Date: 2026-07-16

## Starting defect

The public component pages were rendering QA anatomy rather than user-facing components:

- overlay content was visible inline before interaction;
- dialogs and sheets did not behave like viewport overlays;
- menus contained placeholder anatomy instead of usable actions;
- button examples did not compose with feedback such as Toast;
- Switch, Slider, Toggle Group, Command, and Input OTP were incomplete or visually malformed;
- a catalog decoration helper mutated the real rendered DOM after framework components mounted.

The most important root cause was `decorateCatalogPreview`: it rewrote component output on public routes, including emptying OTP slots and replacing menu content. The public catalog also shared generic anatomy renderers that were useful for QA contracts but unsuitable as product examples.

## Shared catalog corrections

- Removed `decorateCatalogPreview` from public browser fixture rendering.
- Kept QA harness controls isolated to dedicated QA routes.
- Made public overlay examples closed by default.
- Added production presentation for hover, active, focus-visible, disabled, checked, selected, and open states.
- Added fixed portal presentation for modal backdrops, dialogs, sheets, popovers, menus, tooltips, date pickers, and toast viewports.
- Replaced placeholder menu anatomy with Duplicate, Rename, and Delete actions.
- Replaced one-item disclosure and selection fixtures with meaningful multi-item examples.
- Corrected public naming such as `Input OTP`.
- Added reliable screenshot paint settling and software-composited browser capture for local visual evidence.

## React

- Replaced generic Batch B anatomy output with component-specific compositions.
- Wired Accordion, Collapsible, Dialog, Alert Dialog, Sheet, Popover, Tooltip, Hover Card, Dropdown Menu, Context Menu, Menubar, Select, Radio Group, Toggle Group, Tabs, Scroll Area, Switch, Slider, and related controls to actual React primitives.
- Added a six-slot numeric OTP control backed by one accessible input.
- Added stateful Command filtering and selection.
- Added a portalled Date Picker with selection.
- Added trigger-driven Toast/Sonner behavior with fixed viewport, close, Undo, pause-on-hover, auto-dismiss, and swipe dismissal.
- Composed the catalog Button example with Toast.
- Fixed a core React Slider primitive defect where consumer part props containing `style: undefined` overwrote the primitive's computed track/range styles.
- Added a regression test proving Slider track/range styles survive consumer part props.

## Svelte

- Added production compositions for the complete public component inventory.
- Added real overlay mounting and teardown for menus, dialogs, sheets, popovers, tooltips, date picker, and toast.
- Added interactive Switch, Slider, OTP, Toggle Group, Accordion, Command, and data-rich components.
- Composed Button with the actual Toast component through a hidden programmatic trigger so public behavior remains framework-native.

## Vue

- Added production compositions for the complete public component inventory.
- Added real teleported/portalled overlays and interactive controls.
- Added framework-native Toast, data-rich components, Command, Date Picker, OTP, Slider, Switch, menus, and disclosures.
- Composed Button with Toast.

## Solid

- Added production compositions for the complete public component inventory.
- Added real portalled overlays and interactive controls.
- Added framework-native Toast, data-rich components, Command, Date Picker, OTP, Slider, Switch, menus, and disclosures.
- Composed Button with the actual Toast component through a hidden programmatic trigger.
- Fixed the components package build so Solid JSX is compiled with `babel-preset-solid` instead of leaking `React.createElement` into the Solid bundle.
- Verified the built Solid entry contains no `React.createElement`.

## Angular

- Replaced the catalog-only renderer gap with actual Angular component templates.
- Added a body portal directive for menus, modal overlays, sheets, popovers, tooltips, date picker, and toast.
- Fixed the portal directive's Angular dependency injection by using `inject(ElementRef)`.
- Added dialog focus trapping, Escape handling, focus restoration, and body scroll locking.
- Added interactive Switch, Slider, OTP, Command, Date Picker, disclosures, menus, and data-rich inputs.
- Composed Button with Toast.

## Validation

- Public catalog inventory: 45 components in each of 5 frameworks.
- Local browser matrix: 86/86 checks passed.
- Browser findings: 0.
- Blocking findings: 0.
- Browser failures: 0.
- Runtime console errors: 0.
- Per framework, the browser matrix verifies:
  - Button opens a portalled Toast.
  - Context Menu opens on right click with three actions.
  - Dialog opens as a modal portal, locks scrolling, closes, and restores scrolling.
  - Sheet portals and aligns to the viewport edge.
  - Popover and Tooltip portal after their triggers.
  - Switch changes checked state.
  - Slider changes to 82 and renders `82%`.
  - Input OTP accepts and renders six digits.
  - Command filters and selects an option.
  - Date Picker portals and selects a date.
  - Accordion expands interactively.
- `@uifn/react` Slider regression tests: 2/2 passed.
- `@uifn/react` typecheck and package build: passed.
- Focused production component tests: 9/9 passed.
- `@uifn/components` typecheck and package build: passed.
- React, SvelteKit, Nuxt/Vue, SolidStart, and Angular production catalog builds: passed.
- Final React catalog rebuild after the primitive Slider fix: passed.

Evidence:

- `uifn/.conduct/evidence/catalog-sites/verification.json`
- `uifn/.conduct/evidence/catalog-sites/*.png`

## Readiness boundary

The implementation is now a credible production-style release candidate, not a completed 10/10 GA certification.

Remaining release work:

- interactively exercise every state and variant of all 45 components, not only the representative high-risk matrix;
- run automated accessibility audits on every public component route;
- add cross-browser coverage beyond the current Chromium local pass;
- add visual regression baselines for every component, state, theme, and responsive breakpoint;
- complete consumer-install smoke tests against packed/published artifacts;
- resolve any defects found by those broader matrices before declaring GA.

## Deployment

No Cloudflare deployment was performed in this run because the requested scope was to keep the work local.
