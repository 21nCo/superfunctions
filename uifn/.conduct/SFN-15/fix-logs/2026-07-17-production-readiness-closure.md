# Production readiness closure fix log

Date: 2026-07-17

## Scope

This closure turns the five framework catalogs into user-facing component catalogs and uses them as a production-readiness harness for the shared primitives and all 45 public components in React, Svelte, Vue, Solid, and Angular.

The work remains local. No Cloudflare deployment, commit, push, or publication was performed.

## Original production defects

- Public pages rendered workbench anatomy and placeholder labels instead of composed UI components.
- Overlay content could be visible inline before interaction.
- Dialogs, sheets, menus, select lists, popovers, tooltips, hover cards, date pickers, and toasts were not consistently mounted outside the preview layout.
- Modal surfaces did not consistently lock body scrolling, trap focus, handle Escape, and restore focus.
- Button examples did not demonstrate hover behavior or compose with feedback.
- Several controls were decorative rather than meaningfully interactive.
- Public component pages lacked complete installation, usage, API, anatomy, state, and example documentation.
- Browser verification covered only a small representative set and did not prove every public component route.

## Catalog implementation

- Built separate catalogs with their real application frameworks:
  - React with Next.js;
  - Svelte with SvelteKit;
  - Vue with Nuxt;
  - Solid with SolidStart;
  - Angular with the Angular application builder.
- Built a shared `/components` landing surface and framework routes under `/components/{framework}`.
- Added a Coss-like documentation shell with searchable inventory, framework identity, live preview, code/states/QA affordances, installation, usage, examples, anatomy, and API sections.
- Rendered 45 actual public components per framework rather than rewriting their DOM after mount.
- Kept internal QA controls on dedicated QA routes instead of exposing them as the public component experience.
- Added real production catalog compositions for static, form, navigation, layout, data-rich, feedback, and overlay families.

## Shared behavior fixes

- Added real portal, teleport, or body-mounted behavior for Dropdown Menu, Context Menu, Menubar, Select, Popover, Tooltip, Hover Card, Dialog, Alert Dialog, Sheet, Date Picker, Toast, and Sonner.
- Ensured overlay content is absent or hidden before its trigger is used.
- Added modal body scroll locking, focus entry, forward and reverse focus trapping, Escape dismissal, and trigger focus restoration.
- Added keyboard opening, first-item focus, Escape dismissal, and focus restoration for menus and Select.
- Added Shift+F10 and ContextMenu-key support for Context Menu.
- Added focus and hover activation plus pointer-leave and Escape dismissal for Tooltip and Hover Card.
- Added interactive Accordion, Collapsible, Checkbox, Radio Group, Switch, Slider, Tabs, Toggle, Toggle Group, Select, Form, Pagination, Calendar, Date Picker, Input OTP, Command, Data Table, Resizable, Scroll Area, and Sidebar examples.
- Added Button hover-state verification and a real portalled Toast opened by Button.
- Added Toast/Sonner dismissal, Undo, automatic dismissal, pause-on-hover, and swipe behavior.
- Added responsive presentation for desktop and mobile catalog layouts.

## Core and React fixes

- Prevented handled Select keyboard events from falling through to native button activation and closing the list unexpectedly.
- Focused the first option when React Select opens by keyboard and restored focus after dismissal.
- Focused the first menu item when React Dropdown Menu and Menubar open by keyboard.
- Corrected the Menubar regression assertion to match the accessible behavior: switching to an open menu focuses its first item, while Escape returns focus to the active top-level trigger.
- Added keyboard opening and focus restoration to the React Context Menu primitive.
- Preserved computed React Slider track and range styles when consumer part props contain `style: undefined`.

## Svelte fixes

- Added complete production compositions for the public inventory.
- Added body-mounted overlays and teardown for menus, selection, modal, popup, hover, date, and feedback components.
- Added Context Menu keyboard opening, first-item focus, Escape dismissal, and focus restoration.
- Added framework-native interactive control, data-rich, OTP, Command, Date Picker, and Toast behavior.

## Vue fixes

- Added complete production compositions for the public inventory.
- Added teleported overlays for selection, menu, modal, popup, hover, date, and feedback components.
- Added Context Menu keyboard opening, first-item focus, Escape dismissal, and focus restoration.
- Added a modal focus trap for Dialog, Alert Dialog, and Sheet.
- Added framework-native interactive control, data-rich, OTP, Command, Date Picker, and Toast behavior.

## Solid fixes

- Added complete production compositions for the public inventory.
- Added portalled overlays for selection, menu, modal, popup, hover, date, and feedback components.
- Added Context Menu keyboard opening, first-item focus, Escape dismissal, and focus restoration.
- Added modal focus traps for Dialog, Alert Dialog, and Sheet.
- Corrected Solid SSR verification so the focused SSR test runs under the Solid Vitest configuration instead of being appended to a jsdom test command.
- Built Solid JSX with `babel-preset-solid`, preventing `React.createElement` leakage into the Solid package.

## Angular fixes

- Replaced the catalog-only renderer gap with actual Angular component templates.
- Added a body portal directive for menus, selection, modal, popup, hover, date, and feedback components.
- Used synchronous popup positioning after portal mount so the first rendered frame has correct geometry.
- Added Context Menu keyboard opening, first-item focus, Escape dismissal, and focus restoration.
- Added focus trapping, Escape handling, focus restoration, and body scroll locking to modal surfaces.
- Added framework-native interactive control, data-rich, OTP, Command, Date Picker, and Toast behavior.

## Accessibility defect found by Firefox

Firefox found a serious color-contrast violation on the Toast opened by the Button example. The Toast description measured 4.09:1 in Solid and 4.46:1 in Angular while the opacity-based entrance animation was in progress. Solid also exposed the temporarily faded Undo action at 4.37:1.

The fix removes opacity interpolation from the Toast entrance animation while preserving its transform motion. Text and action colors now retain their intended contrast for every animation frame. The rebuilt Solid and Angular Firefox catalogs each pass all 51 checks with zero findings.

## Release infrastructure fixes

- Allowed the five private `uifn/catalogs` workspaces in the package-graph verifier without weakening published-package validation.
- Made package dry-runs use an isolated temporary npm cache so root-owned user-cache entries cannot make the pack gate nondeterministic.
- Refreshed registry catalog source checksums after intentional regression-test changes.
- Corrected the Solid adapter verifier command.
- Verified 16 publishable package tarballs and rejected forbidden local path classes.
- Inspected and refreshed the legacy visual hash manifest only after representative screenshots passed geometry, clipping, text-overlap, theme-token, and accessibility checks.
- Generated five isolated visual manifests, verified their non-overlapping coverage, then merged exactly 4,620 expected keys.
- Replayed all merged visual baselines without update mode to prove they are deterministic.

## Browser and visual evidence

### Chromium

- Complete public catalog: 251/251 checks passed.
- Complete component routes: 225/225 component pages passed documentation, behavior, axe, and responsive checks.
- Keyboard overlay matrix: 76/76 checks passed.
- Findings, blocking findings, runtime console errors, and failures: 0.

Evidence:

- `uifn/.conduct/evidence/catalog-sites-final-chromium/verification.json`
- `uifn/.conduct/evidence/catalog-sites-keyboard-overlays-chromium-final/verification.json`

### WebKit

- Critical cross-framework matrix: 86/86 checks passed.
- Full framework reports: 51/51 each for React, Svelte, Vue, Solid, and Angular.
- Aggregate full-framework result: 255/255 checks passed.
- Findings, blocking findings, and failures: 0.

Evidence:

- `uifn/.conduct/evidence/catalog-sites-webkit-critical/verification.json`
- `uifn/.conduct/evidence/catalog-sites-webkit-react-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-webkit-svelte-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-webkit-vue-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-webkit-solid-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-webkit-angular-final/verification.json`

### Firefox

- Full framework reports: 51/51 each for React, Svelte, Vue, Solid, and Angular.
- Aggregate result: 255/255 checks passed.
- Findings, blocking findings, and failures: 0 after the Toast animation fix.

Evidence:

- `uifn/.conduct/evidence/catalog-sites-firefox-react-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-firefox-svelte-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-firefox-vue-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-firefox-solid-final/verification.json`
- `uifn/.conduct/evidence/catalog-sites-firefox-angular-final/verification.json`

### Legacy workbench visual matrix

- 385/385 routes passed after reviewed baseline refresh.
- 4,620/4,620 theme and viewport cells passed.
- Matrix: 5 frameworks, 77 routes, 4 themes, and 3 viewports.
- Each cell verifies nonblank rendering, geometry, clipping, text overlap, theme tokens, axe, and the threshold hash baseline.

Baseline:

- `uifn/examples/browser-qa/baselines/visual-hashes.json`

## Package and test evidence

- Core: typecheck passed; 107/107 tests passed.
- React: typecheck/build passed; 73/73 tests passed.
- Svelte: typecheck/build passed; 65/65 tests passed.
- Vue: typecheck/build passed; 32/32 tests passed.
- Solid: default 7/7 plus hooks/adapter matrix 7/7 passed; SSR adapter verification passed.
- Angular: typecheck/build passed; 13/13 tests passed.
- Registry: verifier passed; 13/13 tests passed.
- Storybook: 6/6 tests passed.
- Catalog inventory: 45 components and 2 hooks passed.
- Documentation verifier: 75 pages passed.
- Package graph passed with 5 private catalog workspaces and publishable packages kept separate.
- Pack verifier: 16/16 publishable packages passed.
- All five production catalog builds passed after the final accessibility fix.

## Dependency and security boundary

The root monorepo audit reports advisories in the wider repository and private catalog build tools. That result is not a published `uifn` runtime dependency result because npm resolves the root workspace graph.

Inspection of all 16 publishable `uifn` package manifests and tarballs found only `@uifn/*` runtime dependencies; React, Svelte, Vue, Solid, and Angular are peer dependencies. The private, statically built catalogs include framework/build-tool versions that should be upgraded in a separate dependency-maintenance task. No claim is made that the entire monorepo dependency graph is advisory-free.

## Inspection limitation

The Chrome extension bridge was attempted twice but reported `Browser is not available: extension`. Chrome was installed and running, but the extension/native-host communication surface was unavailable. No Chrome-extension inspection is claimed. Chromium, WebKit, and Firefox Playwright matrices provide the runtime evidence recorded above.

## Final release gate

- `npm run verify:uifn-release`: pending independent completion.

## Deployment

No deployment was performed. The catalogs and evidence remain local for review.
