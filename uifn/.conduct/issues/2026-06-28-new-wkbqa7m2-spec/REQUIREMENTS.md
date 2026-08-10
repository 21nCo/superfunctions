# Requirements

## Table of Contents

- WB-001 Workbench package family
- WB-002 Full component inventory
- WB-003 Framework route parity
- WB-004 Human examples and product scenarios
- QA-001 Shared QA contracts
- QA-002 Real browser execution
- QA-003 Overlay and floating geometry
- QA-004 Controls and forms behavior
- QA-005 Data-rich behavior
- QA-006 Static, feedback, layout, and typography behavior
- QA-007 Accessibility
- QA-008 Visual matrix
- QA-009 Patterns and SF panels
- QA-010 Structured evidence and sharding
- SEC-001 Offline and secret-free examples
- REL-001 Release integration
- DOC-001 Documentation and discoverability

## WB-001

- Priority: P0
- Statement: uifn examples MUST provide private Workbench apps for React, Svelte, Vue, Solid, and Angular.
- Rationale: The current examples cover only React, Svelte, and Vue, which leaves Solid and Angular without human or browser QA surfaces.
- Acceptance criteria:
  - Private workspace manifests exist for all five Workbench apps.
  - Each app has dev, build, preview, and browser-test scripts.
  - The example hub can run every framework app by name.
- Test vectors: TV-WB-001, TV-WB-001-N
- Notes: Existing playgrounds MAY be renamed or migrated in place.

## WB-002

- Priority: P0
- Statement: Every Workbench app MUST render every component in the 45-component registry inventory.
- Rationale: Example apps must not cover only easy demos or overlays.
- Acceptance criteria:
  - Verification compares Workbench routes against uifn/components/registry/components.
  - Each of the 45 component slugs has an index route, state route, QA route, and at least one product-like usage route.
  - Verification fails if any registry component is missing.
- Test vectors: TV-COMP-001, TV-COMP-001-N
- Notes: Component drift MUST be detected automatically.

## WB-003

- Priority: P0
- Statement: Framework Workbench apps MUST expose the same route IDs, fixture IDs, and QA case IDs for the same supported surface.
- Rationale: Cross-framework QA is only meaningful when each app renders the same cases.
- Acceptance criteria:
  - Route manifests are generated from shared data.
  - Unsupported framework capabilities render explicit unsupported routes.
  - Verification fails on route drift.
- Test vectors: TV-FW-001, TV-FW-001-N
- Notes: Unsupported routes are allowed only when declared in a shared capability matrix.

## WB-004

- Priority: P1
- Statement: Workbench apps MUST provide human-readable product scenarios in addition to isolated QA fixtures.
- Rationale: Developers and designers need realistic examples, while QA needs deterministic fixtures.
- Acceptance criteria:
  - Each component appears in at least one product-like page or scenario.
  - Patterns and SF panels appear in workflow pages, not only isolated cards.
  - Scenario pages link to focused QA routes.
- Test vectors: TV-WB-002, TV-WB-002-N
- Notes: Product scenarios MAY group multiple components.

## QA-001

- Priority: P0
- Statement: Every component, pattern, and SF panel MUST have a shared QA contract.
- Rationale: Generated Workbench routes and generated browser tests need one source of truth.
- Acceptance criteria:
  - Contracts include slug, family, frameworks, QA profile, states, interactions, a11y, geometry, visual, responsive, themes, and fixtures.
  - Contract validation rejects missing required fields.
  - Contract validation rejects unknown component slugs.
- Test vectors: TV-QA-001, TV-QA-001-N
- Notes: The contract schema is versioned.

## QA-002

- Priority: P0
- Statement: Browser QA MUST run against real mounted Workbench app routes through Playwright Chromium.
- Rationale: Static HTML and jsdom do not prove real click, hover, focus, layout, scroll, or placement behavior.
- Acceptance criteria:
  - Tests start or reuse framework Workbench dev/preview servers.
  - Tests navigate to real URLs.
  - Tests perform pointer, keyboard, scroll, hover, resize, and form input actions.
  - Tests fail if a route is unreachable or blank.
- Test vectors: TV-BROWSER-001, TV-BROWSER-001-N
- Notes: Browser tests MAY run headless by default.

## QA-003

- Priority: P0
- Statement: Overlay and floating components MUST have geometry and collision QA for default, edge, scroll, clipping, transformed-parent, mobile, long-content, nested, and RTL cases where supported.
- Rationale: Dropdowns, menus, selects, comboboxes, popovers, hover cards, tooltips, dialogs, alert dialogs, and sheets can pass static tests while rendering in the wrong place.
- Acceptance criteria:
  - Tests click or hover real triggers and inspect content bounding boxes.
  - Content remains visible inside the viewport or declared clipping boundary.
  - Content alignment to trigger is within contract tolerance.
  - Escape, outside click, and tab behavior follow the component contract.
  - Edge triggers exercise top-left, top-right, bottom-left, and bottom-right cases.
- Test vectors: TV-OVERLAY-001, TV-OVERLAY-001-N
- Notes: Expected placement may be flip, shift, constrain, center, or side placement depending on component.

## QA-004

- Priority: P0
- Statement: Control and form components MUST have interactive browser QA for value changes, validation, disabled/readonly states, keyboard input, labels, and submitted form values.
- Rationale: Form correctness cannot be proven by visual snapshots.
- Acceptance criteria:
  - Tests cover button, checkbox, collapsible, form, input, input-otp, pagination, radio-group, select, slider, switch, tabs, textarea, toggle, and toggle-group.
  - Tests assert DOM state, ARIA state, callback-visible state, and form data where applicable.
  - Tests cover disabled and invalid negative paths.
- Test vectors: TV-FORM-001, TV-FORM-001-N
- Notes: Components that are not native form controls MUST expose their intended form semantics or be explicitly non-form.

## QA-005

- Priority: P0
- Statement: Data-rich and layout components MUST have browser QA for large data, empty/error/loading states, responsive layout, keyboard navigation, resize behavior, and persistence where applicable.
- Rationale: Calendar, command, data-table, date-picker, resizable, scroll-area, and sidebar have behavior that static checks miss.
- Acceptance criteria:
  - Data-table tests cover sorting, filtering, pagination, selection, large data, empty, loading, and error.
  - Calendar and date-picker tests cover min/max, disabled dates, keyboard navigation, and locale/timezone determinism.
  - Command tests cover filtering, disabled options, empty, loading, and keyboard selection.
  - Resizable tests cover pointer drag, keyboard resizing, min/max, orientation, and nested panels.
  - Sidebar tests cover responsive collapse, nested navigation, focus, and persistence.
- Test vectors: TV-DATA-001, TV-DATA-001-N
- Notes: Large data fixtures MUST be deterministic.

## QA-006

- Priority: P1
- Statement: Static, feedback, layout, and typography components MUST have browser QA for rendering, semantics, responsive behavior, and theme behavior.
- Rationale: Simple components still regress visually, semantically, and under themes.
- Acceptance criteria:
  - Static tests cover aspect-ratio, avatar, badge, card, label, progress, separator, skeleton, table, and typography.
  - Feedback tests cover sonner, toast, progress, and skeleton.
  - Layout tests cover aspect-ratio, card, resizable, scroll-area, separator, and sidebar.
  - Tests assert no blank output, expected semantic roles, stable dimensions, and theme token application.
- Test vectors: TV-STATIC-001, TV-STATIC-001-N
- Notes: Static does not mean untested.

## QA-007

- Priority: P0
- Statement: Browser QA MUST run accessibility checks for every component route and every product scenario route.
- Rationale: A11y must be proven against actual rendered browser DOM.
- Acceptance criteria:
  - Axe runs on every component QA route.
  - Keyboard traversal is asserted for focusable components.
  - Focus trap, focus return, and scroll lock are asserted for dialog-like components.
  - Accessible names are asserted for controls and landmarks.
- Test vectors: TV-A11Y-001, TV-A11Y-001-N
- Notes: Known intentional axe suppressions MUST be contract-owned and justified.

## QA-008

- Priority: P0
- Statement: Browser QA MUST run visual checks across themes, viewports, and states.
- Rationale: Nonblank screenshots alone do not catch layout, overflow, theme, and state regressions.
- Acceptance criteria:
  - Themes: light, dark, high-contrast-light, high-contrast-dark.
  - Viewports: mobile, tablet, desktop.
  - Reduced motion is tested.
  - Screenshots are keyed by framework, family, slug, route, state, theme, and viewport.
  - Visual checks fail on blank output, major clipping, text overlap, and unexpected baseline drift.
- Test vectors: TV-VISUAL-001, TV-VISUAL-001-N
- Notes: Baseline update flow MUST be explicit.

## QA-009

- Priority: P1
- Statement: Workbench and browser QA MUST cover all controlled patterns and all Superfunction-backed panel variants.
- Rationale: uifn is more than primitive components; product patterns and SF-backed panels are part of the stack.
- Acceptance criteria:
  - 14 controlled patterns render in each framework.
  - 14 SF panels render in each framework with injected fake clients.
  - SF panel states cover loading, empty, error, partial, permission-denied, optimistic, success, degraded-network, and unsupported-capability.
  - Tests reject global client reads and live network calls.
- Test vectors: TV-PATTERN-001, TV-SF-001, TV-SF-001-N
- Notes: Live backend QA is Undefined.

## QA-010

- Priority: P0
- Statement: Browser QA MUST emit structured, shardable evidence with deterministic failure codes.
- Rationale: Failures must be debuggable and suitable for release gates.
- Acceptance criteria:
  - Results follow UifnBrowserQaResult.
  - Commands support filters by framework, family, profile, slug, and route.
  - Failures include code, framework, slug, route, assertion type, and sanitized evidence.
  - Screenshots/traces are captured on failure when enabled.
- Test vectors: TV-REPORT-001, TV-REPORT-001-N
- Notes: Evidence MUST be sanitized.

## SEC-001

- Priority: P0
- Statement: Workbench apps MUST be offline, secret-free, and deterministic.
- Rationale: Examples should be safe to run locally and in CI without backend credentials.
- Acceptance criteria:
  - No .env files are required.
  - Static verification rejects fetch, XMLHttpRequest, WebSocket, sendBeacon, secret-like tokens, and local absolute paths in examples.
  - SF fake clients are injected through fixtures.
- Test vectors: TV-SEC-001, TV-SEC-001-N
- Notes: External CDN assets are not allowed unless separately approved.

## REL-001

- Priority: P0
- Statement: Workbench verification MUST be integrated into release gates before uifn GA.
- Rationale: Examples must not rot separately from the published package surface.
- Acceptance criteria:
  - verify:uifn-release includes at least the required Workbench static and browser gates before GA.
  - Release evidence reports component, pattern, SF, framework, route, and check counts.
  - No planned or skipped browser checks may pass release unless explicitly marked unsupported in contracts.
- Test vectors: TV-REL-001, TV-REL-001-N
- Notes: Heavy full matrix MAY be shardable, but release must still require the shards.

## DOC-001

- Priority: P1
- Statement: uifn docs MUST link to the Workbench apps and explain how to run browser QA.
- Rationale: The current examples verifier failed on stale README links.
- Acceptance criteria:
  - uifn/README.md links to the Workbench hub.
  - Each framework README links to its Workbench app.
  - Docs list dev ports, QA commands, route conventions, and supported frameworks.
  - Docs explain that examples are private and not published.
- Test vectors: TV-DOC-001, TV-DOC-001-N
- Notes: Docs MUST avoid local absolute paths.
