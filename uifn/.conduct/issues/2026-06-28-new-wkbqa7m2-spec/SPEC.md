# uifn Example Workbench and Full Browser QA Spec

## Metadata

- timestamp: 2026-06-28T13:09:35Z
- agent_name: Codex
- model: GPT-5 Codex
- launcher: Codex Desktop
- workspace: repo root
- OS: Darwin arm64
- shell: zsh
- git branch: SFN-15
- git commit: 9cf38123
- git dirty status: dirty, 151 status entries at spec generation
- spec_folder: 2026-06-28-new-wkbqa7m2-spec
- spec path: uifn/.conduct/issues/2026-06-28-new-wkbqa7m2-spec
- spec_type: new
- spec_id: wkbqa7m2
- input paths read:
  - uifn/examples/README.md
  - uifn/examples/package.json
  - uifn/examples/scripts/verify.mjs
  - uifn/examples/shared/src/scenarios.ts
  - uifn/examples/shared/src/capabilities.ts
  - uifn/examples/react-playground/src/App.tsx
  - uifn/components/registry/components
  - uifn/patterns/stories
  - uifn/sf/stories
  - uifn/components/src/__tests__/browser-workshop.test.ts

## Overview

uifn examples MUST become a catalog-driven Workbench that serves both human examples and full real-browser product QA. Each supported framework app MUST render every uifn component, every controlled pattern, and every Superfunction-backed panel state from shared manifests. Automated Playwright QA MUST exercise real browser behavior, layout, a11y, visual output, keyboard interaction, pointer interaction, form behavior, data-rich behavior, responsive behavior, theme behavior, and failure cases.

The current example apps are useful but too thin: React, Svelte, and Vue playgrounds exist, while Solid and Angular examples do not. The current production browser tests are stronger than examples, but they are test-only generated workshops rather than a human-facing, routable QA workbench. This spec replaces that split with one shared Workbench surface.

## Glossary

- Workbench: the private example app family under uifn/examples that renders uifn surfaces for humans and automated QA.
- Framework app: one of React, Svelte, Vue, Solid, or Angular Workbench apps.
- Component: a styled base component listed in uifn/components/registry/components.
- Pattern: a controlled product pattern under uifn/patterns.
- SF panel: a Superfunction-backed pattern under uifn/sf that uses injected fake clients in examples.
- QA contract: a manifest-owned test contract that defines required states, interactions, geometry assertions, a11y checks, and visual checks for a component or pattern.
- Scenario route: a deterministic Workbench route that renders one product-like example or one QA fixture.
- Geometry assertion: a browser assertion using real element bounding boxes, viewport dimensions, scroll positions, and clipping checks.
- Collision case: a placement edge case where trigger/content geometry is near a viewport, scroll container, transformed parent, overflow clipping boundary, or nested overlay.

## Goals

- Every supported framework MUST have a Workbench app: React, Svelte, Vue, Solid, and Angular.
- Every framework Workbench app MUST render every one of the 45 current components.
- Every framework Workbench app MUST render every controlled pattern and every SF panel variant.
- Examples MUST be generated from shared manifests and QA contracts, not manually divergent per-framework pages.
- Playwright MUST test the same routes humans can open in a browser.
- Browser QA MUST include real interaction and geometry checks, not only static screenshots.
- Browser QA MUST be release-gate eligible and produce structured evidence.
- Examples MUST remain private workspaces and MUST NOT require real network, secrets, or live Superfunction backends.

## Non-goals

- This spec does not require publishing example apps to npm.
- This spec does not require replacing unit tests, adapter conformance tests, registry tests, or package pack checks.
- This spec does not require live authfn, plugfn, filefn, or billfn services. SF examples MUST use injected fake clients.
- This spec does not require pixel-perfect snapshots for every pixel of every component. It requires deterministic visual assertions and reviewed baselines for supported states.
- Anything not listed in this spec is Undefined.

## Public API

### Workspace Packages

The example workspace family MUST expose these private packages:

```txt
@uifn/examples
@uifn/examples-shared
@uifn/example-react-workbench
@uifn/example-svelte-workbench
@uifn/example-vue-workbench
@uifn/example-solid-workbench
@uifn/example-angular-workbench
```

Existing playground names MAY be migrated in place or replaced, but the final public workspace command surface MUST use Workbench naming.

### Root Commands

The repo root MUST expose:

```bash
npm run verify:uifn-examples
npm run verify:uifn-browser
npm run verify:uifn-overlays
npm run verify:uifn-workbench
```

`verify:uifn-examples` MUST build and statically validate Workbench workspaces.

`verify:uifn-browser` MUST run the full real-browser Playwright QA suite.

`verify:uifn-overlays` MUST run the focused overlay/collision subset for dropdown-menu, context-menu, menubar, select, combobox, popover, hover-card, tooltip, dialog, alert-dialog, and sheet.

`verify:uifn-workbench` MUST run examples static validation plus browser validation.

### Workbench Routes

Each framework app MUST expose deterministic routes:

```txt
/
/components
/components/:slug
/components/:slug/states
/components/:slug/qa
/components/:slug/qa/:caseId
/patterns
/patterns/:slug
/patterns/:slug/qa
/sf
/sf/:slug
/sf/:slug/qa
/qa/all
/qa/overlays
/qa/forms
/qa/data-rich
/qa/keyboard
/qa/responsive
/qa/themes
```

Routes MUST use the same route IDs across all framework apps.

### QA Contract Shape

Each component, pattern, and SF panel MUST have a canonical QA contract:

```ts
export interface UifnQaContract {
  schemaVersion: 1;
  family: "component" | "pattern" | "sf";
  slug: string;
  displayName: string;
  frameworks: Array<"react" | "svelte" | "vue" | "solid" | "angular">;
  qaProfile:
    | "static"
    | "control"
    | "form"
    | "overlay"
    | "navigation"
    | "feedback"
    | "layout"
    | "data-rich"
    | "typography";
  requiredRoutes: string[];
  requiredStates: string[];
  requiredInteractions: string[];
  requiredA11y: string[];
  requiredGeometry: string[];
  requiredVisual: string[];
  requiredResponsive: string[];
  requiredThemes: Array<"light" | "dark" | "high-contrast-light" | "high-contrast-dark">;
  fixtures: Array<{
    id: string;
    route: string;
    args: Record<string, unknown>;
    expectedDom: Record<string, unknown>;
    expectedBehavior: Record<string, unknown>;
  }>;
}
```

### QA Result Envelope

All browser QA commands MUST emit structured JSON:

```ts
export interface UifnBrowserQaResult {
  ok: boolean;
  command: string;
  schemaVersion: 1;
  frameworkCount: number;
  componentCount: number;
  patternCount: number;
  sfPanelCount: number;
  routeCount: number;
  checks: Array<{
    id: string;
    family: "component" | "pattern" | "sf";
    slug: string;
    framework: "react" | "svelte" | "vue" | "solid" | "angular";
    route: string;
    status: "passed" | "failed";
    evidence: Record<string, unknown>;
  }>;
  failures: Array<{
    code: string;
    message: string;
    slug?: string;
    framework?: string;
    route?: string;
    evidence?: Record<string, unknown>;
  }>;
}
```

## Full Component Inventory

The Workbench and browser QA MUST cover every component listed here:

1. accordion
2. alert-dialog
3. aspect-ratio
4. avatar
5. badge
6. breadcrumb
7. button
8. calendar
9. card
10. checkbox
11. collapsible
12. command
13. context-menu
14. data-table
15. date-picker
16. dialog
17. dropdown-menu
18. form
19. hover-card
20. input
21. input-otp
22. label
23. menubar
24. pagination
25. popover
26. progress
27. radio-group
28. resizable
29. scroll-area
30. select
31. separator
32. sheet
33. sidebar
34. skeleton
35. slider
36. sonner
37. switch
38. table
39. tabs
40. textarea
41. toast
42. toggle
43. toggle-group
44. tooltip
45. typography

The Workbench MUST fail verification if this inventory drifts from uifn/components/registry/components.

## QA Profiles

Every component MUST map to one or more QA profiles:

- static: aspect-ratio, avatar, badge, card, label, progress, separator, skeleton, table, typography
- control: button, checkbox, collapsible, pagination, radio-group, switch, tabs, toggle, toggle-group
- form: form, input, input-otp, select, slider, textarea
- overlay: alert-dialog, context-menu, dialog, dropdown-menu, hover-card, menubar, popover, sheet, tooltip
- navigation: accordion, breadcrumb, menubar, pagination, sidebar, tabs
- feedback: sonner, toast, progress, skeleton
- layout: aspect-ratio, card, resizable, scroll-area, separator, sidebar
- data-rich: calendar, command, data-table, date-picker, resizable, sidebar

If a component appears in multiple profiles, it MUST satisfy every applicable profile.

## Semantics

### Workbench Generation

Workbench apps MUST be generated from shared contracts. Framework-specific renderers MAY be handwritten, but route lists, fixture IDs, scenario names, QA IDs, expected interactions, and required assertions MUST come from shared data.

### Framework Parity

Each framework app MUST expose the same route tree, same component slugs, same pattern slugs, same SF slugs, same fixture IDs, and same QA case IDs. If a framework has a known unsupported feature, the Workbench MUST render an explicit unsupported state and browser QA MUST assert that the state is intentional.

### Real Browser Behavior

Browser QA MUST run against real mounted app routes through Playwright. Tests MUST click, type, hover, press keyboard shortcuts, scroll, resize viewports, and inspect bounding boxes. Tests MUST NOT rely only on jsdom, static HTML, or serialized component output.

### Overlay and Floating Placement

Overlay components MUST be tested for:

- default placement
- top-left viewport edge
- top-right viewport edge
- bottom-left viewport edge
- bottom-right viewport edge
- narrow mobile viewport
- inside scroll container
- inside overflow clipping container
- inside transformed parent
- long content
- nested overlay
- RTL layout where supported

Expected behavior MUST be contract-specific: content may flip, shift, constrain max size, or change placement, but it MUST remain visible, reachable, and semantically attached to the trigger.

### Visual Behavior

Visual QA MUST cover light, dark, high-contrast-light, and high-contrast-dark themes; mobile, tablet, and desktop viewports; reduced motion; loading, empty, error, disabled, invalid, selected, active, open, and success states where applicable.

### Patterns and SF Panels

Patterns and SF panels MUST be represented as product-like routes, not only isolated cards. SF panel examples MUST use injected fake clients and MUST cover loading, empty, error, partial, permission-denied, optimistic, success, degraded-network, and unsupported-capability states.

## Invariants

- Component count MUST equal registry component count.
- Framework route matrices MUST be equal except for explicitly declared unsupported cases.
- Browser QA MUST be deterministic under fixed viewport, theme, reduced-motion, timezone, locale, and seed.
- Tests MUST fail on missing routes, missing states, missing interactions, missing visual coverage, missing a11y coverage, and missing geometry coverage.
- Workbench examples MUST NOT make live network calls.
- Workbench examples MUST NOT read secrets or machine-local env files.
- Workbench examples MUST NOT require absolute filesystem paths.

## Security

Examples MUST use fake data and fake clients only. Logs, screenshots, traces, and JSON evidence MUST NOT contain tokens, local absolute paths, PII, upload URLs, or backend credentials. SF clients MUST be injected into route fixtures and MUST NOT be global singletons.

## Limits and Caps

- Browser QA MUST support sharding by framework, family, profile, slug, and route.
- A single route MUST render one primary fixture unless it is an index/gallery route.
- Data-rich large-list fixtures SHOULD cap default visual rows to a deterministic viewport while still testing virtualized large data.
- Visual baselines MUST be bounded by theme, viewport, framework, slug, state, and fixture ID.

## Observability

Browser QA MUST emit JSON summaries and per-failure evidence. Failures MUST include framework, slug, route, QA case ID, assertion type, and sanitized DOM or geometry evidence. Screenshots and traces MAY be captured on failure, but MUST be sanitized and kept out of published packages.

## Compatibility and Versioning

The Workbench is private and MAY break before GA. Once uifn reaches GA, QA contract schema changes MUST bump the QA contract schema version and include migration notes. Generated route IDs SHOULD remain stable after GA unless a component or behavior is removed through an intentional breaking change.

## Undefined / Explicitly User-Deferred Only

- Public hosted documentation deployment is Undefined.
- Cross-browser matrix beyond Chromium is Undefined unless separately requested.
- Native mobile WebView QA is Undefined.
- Live backend integration QA is Undefined.
- Pixel-perfect design approval workflow is Undefined.
