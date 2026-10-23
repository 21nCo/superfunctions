# uifn Audit 45c676d1 Fix Inventory

## Metadata

- Created: 2026-07-01
- Scope: `uifn` Workbench QA and release verification
- Source audit: `uifn/.conduct/audits/2026-06-30-45c676d1-full-audit.md`
- Related spec: `uifn/.conduct/issues/2026-06-28-new-wkbqa7m2-spec`
- Purpose: inventory every fix required to resolve the audit findings and make the Workbench QA implementation prove real component behavior instead of only route/render existence.

## Executive Summary

The audit finds that the current Workbench implementation has useful breadth but insufficient semantic depth. The existing route inventory, five-framework workbenches, static validation, and browser runners are real. However, several browser checks can pass without proving the actual component behavior required by the spec.

The core fixes are:

1. Replace synthetic form/data probes with component-owned assertions.
2. Model multi-profile components correctly and fix profile filtering.
3. Verify actual overlay/floating content geometry and interaction semantics.
4. Upgrade visual QA from nonblank screenshot checks to deterministic visual checks.
5. Add runtime network interception for examples, patterns, and SF panels.
6. Make release run complete Workbench browser coverage, not only smoke plus overlays.
7. Improve long-running browser gate progress, sharding, artifacts, and evidence normalization.
8. Strengthen human product scenarios, a11y/keyboard checks, static/layout checks, and deterministic data/date behavior.

## Current Audit Status

| Requirement | Audit status | Inventory status |
| --- | --- | --- |
| WB-001 Workbench package family | PASS | No functional fix required |
| WB-002 Full component inventory | PARTIAL | Fix dynamic behavior proof |
| WB-003 Framework route parity | PASS | Preserve existing catalog-driven route generation |
| WB-004 Human examples and product scenarios | PARTIAL | Make scenarios richer product workflows |
| QA-001 Shared QA contracts | PASS | Extend contract shape for multi-profile semantics |
| QA-002 Real browser execution | PARTIAL | Make browser assertions component-owned and deeper |
| QA-003 Overlay and floating geometry | FAIL | Add real overlay assertions and include `select` |
| QA-004 Controls and forms behavior | FAIL | Remove probe-backed false positives |
| QA-005 Data-rich behavior | FAIL | Remove probe-backed false positives |
| QA-006 Static, feedback, layout, typography behavior | PARTIAL | Add semantic/layout/token/text-overlap checks |
| QA-007 Accessibility | PARTIAL | Add component-specific keyboard/focus assertions |
| QA-008 Visual matrix | FAIL | Add real visual comparison and artifacts |
| QA-009 Patterns and SF panels | PARTIAL | Add real network interception and pattern-specific checks |
| QA-010 Structured evidence and sharding | PARTIAL | Normalize evidence, progress, artifacts, and skipped coverage |
| SEC-001 Offline and secret-free examples | PARTIAL | Add browser-runtime network enforcement |
| REL-001 Release integration | FAIL | Include complete Workbench browser matrix |
| DOC-001 Documentation and discoverability | PASS | Update docs after behavior/gate changes |

## Fix Inventory

### FIX-001: Replace synthetic form probes with component-owned form assertions

- Priority: P0
- Audit findings: `QA-004`, `WB-002`, `QA-002`
- Problem: `form-submit` routes inject `formProbeHtml` beside the component, and `exerciseInteractions` submits `[data-uifn-workbench-form]`. This can pass even if the actual form/control component is broken.
- Affected areas:
  - `uifn/examples/shared/src/workbench-model.ts`
  - `uifn/examples/*-workbench/src/*`
  - `uifn/examples/browser-qa/src/assertions/interaction.mjs`
  - `uifn/examples/browser-qa/src/runner.mjs`
  - `uifn/examples/shared/src/component-inventory.ts`

Required work:

- Remove generic form probes as the primary pass condition.
- Keep any harness-only form wrapper explicitly marked as harness metadata, never as component behavior evidence.
- For each form/control component profile, render the actual component in a controlled test fixture with deterministic props, callbacks, labels, disabled state, invalid state, and submitted value paths.
- Add component-specific selectors or part metadata to the contract so the runner can locate the real control root, input/value surface, label, error text, and submit path.
- Assert actual component behavior:
  - typed value persists where applicable,
  - submitted form data comes from the component value,
  - `aria-invalid` reflects invalid fixtures,
  - disabled controls do not mutate value or submit,
  - label association works,
  - keyboard input works,
  - controlled and uncontrolled value paths behave consistently.

Acceptance criteria:

- `formProbeHtml` is no longer used as evidence for `TV-FORM-001`.
- A deliberately broken component value path fails browser QA with a stable code such as `UIFN_FORM_COMPONENT_VALUE_MISMATCH`.
- `npm run verify:uifn-browser -- --profile form` drives actual component DOM, not a generic sidecar form.
- `input`, `input-otp`, `select`, `checkbox`, `radio-group`, `switch`, `slider`, `textarea`, `combobox`, and equivalent form/control fixtures have direct component assertions.

Verification commands:

```bash
npm --workspace @uifn/examples-shared run build
npm run verify:uifn-browser -- --profile form
npm run verify:uifn-browser -- --framework react --slug input-otp --route /components/input-otp/qa/form-submit
npm run verify:uifn-browser -- --framework vue --slug select --route /components/select/qa/form-submit
```

Negative verification:

- Temporarily break a component fixture value binding and confirm the browser gate fails before reverting the intentional break.

### FIX-002: Replace synthetic data probes with component-owned data-rich assertions

- Priority: P0
- Audit findings: `QA-005`, `WB-002`, `QA-002`
- Problem: `large-data` routes inject `dataProbeHtml`, and `assertDataRich` filters/selects that generic probe instead of the actual data-rich component.
- Affected areas:
  - `uifn/examples/shared/src/workbench-model.ts`
  - `uifn/examples/browser-qa/src/runner.mjs`
  - `uifn/examples/browser-qa/src/assertions/*`
  - `uifn/examples/shared/src/component-inventory.ts`
  - framework workbench renderers

Required work:

- Stop using `dataProbeHtml` as data-rich proof.
- Add real large-data fixtures for:
  - `data-table`,
  - `calendar`,
  - `date-picker`,
  - `command`,
  - `resizable`,
  - `scroll-area`,
  - `sidebar`,
  - any other `data-rich` contract route.
- Add contract fields for component-owned data selectors:
  - filter input,
  - sortable header,
  - row selector,
  - selected row state,
  - virtualized window,
  - calendar grid cells,
  - selected date,
  - disabled date,
  - command option,
  - resizable handle,
  - scroll viewport.
- Assert actual behavior:
  - filtering reduces rendered rows deterministically,
  - sorting changes row order,
  - row selection persists,
  - virtualized lists do not show blank gaps,
  - calendar/date-picker fixed dates render under deterministic timezone/locale,
  - keyboard navigation changes active/selected item,
  - resize/scroll interactions update the real component state.

Acceptance criteria:

- `assertDataRich` does not query `[data-uifn-data-probe]` as the pass condition.
- Every `data-rich` route has component-owned evidence.
- Broken filter/selection/date behavior fails browser QA.
- Evidence includes the actual component selectors and state values that were asserted.

Verification commands:

```bash
npm run verify:uifn-browser -- --profile data-rich
npm run verify:uifn-browser -- --framework solid --slug data-table --route /components/data-table/qa/large-data
npm run verify:uifn-browser -- --framework svelte --slug calendar --route /components/calendar/qa/large-data
npm run verify:uifn-browser -- --framework angular --slug command --route /components/command/qa/large-data
```

### FIX-003: Model multiple QA profiles per component

- Priority: P0
- Audit findings: `QA-003`, `QA-010`, spec gap
- Problem: component definitions have `profiles`, but contracts collapse them to one `qaProfile`. Secondary profiles are lost in filters. Example: `select` is `['form', 'overlay']` but `--profile overlay --slug select` returns no routes.
- Affected areas:
  - `uifn/examples/shared/src/qa-contract.ts`
  - `uifn/examples/shared/src/component-inventory.ts`
  - `uifn/examples/shared/src/routes.ts`
  - `uifn/examples/browser-qa/src/filters.mjs`
  - `scripts/verify-uifn-examples.mjs`
  - docs describing QA filters

Required work:

- Add `qaProfiles: UifnQaProfile[]` to the canonical contract.
- Keep `qaProfile` only if needed as a backwards-compatible derived primary profile during this pre-GA work, or remove it cleanly if nothing consumes it.
- Generate route profile metadata per fixture from the fixture's own profile, not only the component primary profile.
- Make `routeMatches` include routes when:
  - `route.profile === filters.profile`,
  - `route.contract.qaProfiles` contains `filters.profile`,
  - the fixture declares the profile,
  - or the route has a matching required geometry/interaction profile where appropriate.
- Add static validation that every component with multiple profiles appears in every corresponding profile-filtered run.

Acceptance criteria:

- `select` appears in overlay and form runs.
- `resizable` appears in data-rich and layout runs.
- `sidebar` appears in data-rich, layout, and navigation runs.
- `menubar` appears in overlay and navigation runs.
- `verify:uifn-examples` fails if any multi-profile component is absent from a required filtered route set.

Verification commands:

```bash
npm --workspace @uifn/examples-shared run build
npm run verify:uifn-examples
npm run verify:uifn-overlays -- --slug select
npm run verify:uifn-browser -- --profile layout --slug resizable
npm run verify:uifn-browser -- --profile navigation --slug sidebar
```

### FIX-004: Implement real overlay/floating assertions

- Priority: P0
- Audit findings: `QA-003`, `QA-007`, `QA-010`
- Problem: overlay QA currently verifies the route root box, not the actual floating content. It does not prove trigger/content association, placement, collision handling, Escape/outside click, focus behavior, or clipping boundaries.
- Affected areas:
  - `uifn/examples/browser-qa/src/assertions/geometry.mjs`
  - new `uifn/examples/browser-qa/src/assertions/overlay.mjs`
  - `uifn/examples/browser-qa/src/runner.mjs`
  - component renderers for overlay fixtures
  - `uifn/examples/shared/src/component-inventory.ts`

Required work:

- Add explicit overlay contract anatomy:
  - trigger selector,
  - content selector,
  - portal/root selector,
  - expected placement,
  - collision boundary,
  - focus-trap expectation,
  - dismissal semantics.
- For each overlay route:
  - open content via the real trigger using pointer and keyboard where applicable,
  - locate actual floating content,
  - assert content is visible and nonblank,
  - assert content is associated with trigger through ARIA or documented part metadata,
  - compare trigger/content boxes with tolerance for expected placement,
  - assert content is not clipped by viewport or clipping container,
  - assert edge fixtures shift/flip/stay visible as specified,
  - assert Escape closes where specified,
  - assert outside click closes where specified,
  - assert tab order/focus remains valid,
  - assert nested overlay route behavior.
- Include `select` overlay portions after FIX-003.

Acceptance criteria:

- `verify:uifn-overlays` checks floating content boxes, not only component root boxes.
- A hidden/clipped/misaligned overlay content node fails with stable error codes:
  - `UIFN_OVERLAY_CONTENT_MISSING`,
  - `UIFN_OVERLAY_CONTENT_CLIPPED`,
  - `UIFN_OVERLAY_PLACEMENT_MISMATCH`,
  - `UIFN_OVERLAY_DISMISSAL_FAILED`,
  - `UIFN_OVERLAY_FOCUS_FAILED`.
- `select` overlay route passes as part of `verify:uifn-overlays`.

Verification commands:

```bash
npm run verify:uifn-overlays
npm run verify:uifn-overlays -- --framework react --slug dropdown-menu --route /components/dropdown-menu/qa/edge-bottom-right
npm run verify:uifn-overlays -- --framework vue --slug select
npm run verify:uifn-overlays -- --framework solid --slug dialog --route /components/dialog/qa/focus-trap
```

### FIX-005: Upgrade visual QA beyond nonblank screenshots

- Priority: P0
- Audit findings: `QA-008`, `QA-006`, `QA-010`
- Problem: `assertVisual` currently only checks screenshot byte size. It cannot detect visual drift, text overlap, clipped content, broken token application, or layout regressions.
- Affected areas:
  - `uifn/examples/browser-qa/src/assertions/visual.mjs`
  - `scripts/verify-uifn-visual.mjs`
  - `uifn/.conduct/SFN-15` evidence schemas if they define visual evidence
  - docs for baseline update flow

Required work:

- Define a deterministic visual evidence model:
  - framework,
  - family,
  - slug,
  - route,
  - fixture/state,
  - theme,
  - viewport,
  - screenshot hash,
  - dimensions,
  - diff status,
  - text-overlap status,
  - clipping status.
- Add baseline storage or a deterministic snapshot manifest under a repo-owned path.
- Add explicit baseline update flow, gated by an intentional flag such as `UIFN_UPDATE_VISUAL_BASELINES=1`.
- Add DOM-based visual assertions independent of image diff:
  - text boxes do not overlap,
  - text remains inside fixed-format controls,
  - root and key child boxes are visible,
  - theme tokens/CSS variables are applied,
  - no placeholder status leaks into production fixtures.
- Keep byte-size nonblank as only one low-level assertion.

Acceptance criteria:

- A screenshot that is nonblank but visually shifted fails the visual gate.
- A route with overlapping labels fails with a stable error code such as `UIFN_VISUAL_TEXT_OVERLAP`.
- Visual failures emit artifact paths or hashes in sanitized evidence.
- Baselines cannot silently update during normal release verification.

Verification commands:

```bash
npm run verify:uifn-browser -- --scope visual --framework svelte --slug calendar --route /components/calendar/qa/themes
npm run verify:uifn-visual
npm run verify:uifn-release
```

### FIX-006: Add runtime network interception and offline enforcement

- Priority: P0
- Audit findings: `SEC-001`, `QA-009`, spec gap
- Problem: static scans reject obvious network APIs, but browser QA does not measure runtime network calls. SF panel evidence hard-codes `noLiveNetworkCalls: 0`.
- Affected areas:
  - `uifn/examples/browser-qa/src/runner.mjs`
  - new `uifn/examples/browser-qa/src/assertions/network.mjs`
  - `uifn/examples/shared/src/sf-inventory.ts`
  - `scripts/verify-uifn-secrets.mjs`
  - `scripts/verify-uifn-examples.mjs`

Required work:

- Install browser-level interception before every route navigation:
  - count `fetch`,
  - count `XMLHttpRequest`,
  - count `WebSocket`,
  - count `navigator.sendBeacon`,
  - count document/subresource requests that leave the local workbench origin.
- Fail nonzero live network calls unless a contract explicitly declares an offline-safe exception.
- Include request type, sanitized URL origin, route, framework, and stack/category where available in evidence.
- Make SF panel assertions verify injected fake clients by both metadata and absence of network calls.
- Preserve static scanning as a first line of defense.

Acceptance criteria:

- Injecting a `fetch("https://example.com")` into any workbench route fails browser QA.
- SF routes report measured `liveNetworkCalls: 0`, not hard-coded metadata.
- Static and runtime no-network checks both run in release.

Verification commands:

```bash
npm run verify:uifn-browser -- --family sf
npm run verify:uifn-browser -- --family pattern
npm run verify:uifn-secrets
npm run verify:uifn-release
```

### FIX-007: Include full Workbench browser coverage in release

- Priority: P0
- Audit findings: `REL-001`, `QA-002`, `QA-010`
- Problem: `verify:uifn-release` runs static examples, browser smoke, and overlays. It does not run the full required Workbench browser matrix before declaring release success.
- Affected areas:
  - `scripts/verify-uifn-release.mjs`
  - `scripts/verify-uifn-workbench.mjs`
  - `scripts/verify-uifn-browser.mjs`
  - `scripts/verify-uifn-overlays.mjs`
  - release evidence schemas

Required work:

- Decide whether release should invoke:
  - `verify:uifn-workbench`, or
  - an equivalent sharded complete Workbench browser suite.
- The release gate MUST include:
  - all five frameworks,
  - all component default routes,
  - all required fixture routes,
  - all profile routes,
  - all patterns,
  - all SF panels,
  - all product scenarios,
  - visual route coverage,
  - overlay route coverage,
  - runtime no-network checks.
- Evidence MUST report:
  - route count,
  - check count,
  - passed/failed/skipped counts,
  - framework coverage,
  - family coverage,
  - profile coverage,
  - theme/viewport coverage where applicable,
  - unsupported route reasons if any.

Acceptance criteria:

- `verify:uifn-release` fails if full Workbench browser coverage did not run.
- `--scope smoke` alone is not sufficient for release success.
- Release evidence proves all required profiles and fixtures were covered.

Verification commands:

```bash
npm run verify:uifn-workbench
npm run verify:uifn-release
node scripts/verify-uifn-release.mjs --dry-run
```

### FIX-008: Add progress, sharding, timeouts, and diagnostics for long browser gates

- Priority: P1
- Audit findings: `QA-010`, operational brittleness
- Problem: long browser commands can sit silent for minutes, making failures hard to diagnose. `maxRoutes` truncates but does not prove full shard coverage.
- Affected areas:
  - `uifn/examples/browser-qa/src/runner.mjs`
  - `uifn/examples/browser-qa/src/filters.mjs`
  - `scripts/verify-uifn-browser.mjs`
  - `scripts/verify-uifn-overlays.mjs`
  - `scripts/verify-uifn-workbench.mjs`
  - `scripts/verify-uifn-release.mjs`

Required work:

- Add structured progress events for:
  - framework start/end,
  - server start/end,
  - route start/end,
  - assertion start/end,
  - shard start/end.
- Add deterministic sharding:
  - `--shard-index`,
  - `--shard-count`,
  - `--list-shards`,
  - shard coverage manifest.
- Add per-route timeout envelopes and assertion-specific timeout codes.
- Add summarized progress to stderr while preserving JSON result on stdout.
- Ensure release can aggregate shard evidence and detect missing shards.

Acceptance criteria:

- Long overlay/browser runs emit progress at least once per route or route group.
- A hung route fails with a route-specific timeout code and evidence.
- Release fails when any shard is missing or truncated.

Verification commands:

```bash
npm run verify:uifn-browser -- --list-shards --shard-count 5
npm run verify:uifn-browser -- --shard-count 5 --shard-index 0
npm run verify:uifn-overlays -- --shard-count 5 --shard-index 0
npm run verify:uifn-release
```

### FIX-009: Normalize Workbench and release evidence envelopes

- Priority: P1
- Audit findings: `QA-010`, error handling
- Problem: browser result envelopes are useful, but wrappers embed child stdout/stderr or compact evidence inconsistently. Failure artifacts/screenshots/traces are not emitted.
- Affected areas:
  - `uifn/examples/browser-qa/src/runner.mjs`
  - `scripts/verify-uifn-workbench.mjs`
  - `scripts/verify-uifn-release.mjs`
  - `uifn/.conduct/SFN-15/release-check.schema.json`
  - `uifn/.conduct/SFN-15/release-evidence.schema.json`

Required work:

- Define one canonical browser QA result shape:
  - `ok`,
  - `command`,
  - `schemaVersion`,
  - `mode`,
  - `coverage`,
  - `checks`,
  - `failures`,
  - `artifacts`,
  - `summary`.
- Make workbench and release wrappers normalize child results into this shape.
- Emit sanitized artifact references for:
  - screenshots,
  - DOM snapshots,
  - console logs,
  - network events,
  - traces where enabled.
- Preserve compact evidence mode without dropping counts.

Acceptance criteria:

- All Workbench/release browser gates produce schema-valid JSON.
- Compact mode keeps route/check/pass/fail/skipped counts.
- A failing route includes enough sanitized artifacts to diagnose it.

Verification commands:

```bash
npm run verify:uifn-workbench
npm run verify:uifn-release
node -e "JSON.parse(require('fs').readFileSync('/tmp/some-uifn-result.json','utf8'))"
```

### FIX-010: Strengthen accessibility and keyboard assertions

- Priority: P1
- Audit findings: `QA-007`, `QA-003`, `QA-004`
- Problem: Axe runs, but keyboard traversal and focus assertions are generic and shallow.
- Affected areas:
  - `uifn/examples/browser-qa/src/assertions/a11y.mjs`
  - `uifn/examples/browser-qa/src/assertions/interaction.mjs`
  - new component/profile-specific assertion helpers

Required work:

- Add profile-specific keyboard expectations:
  - roving tabindex,
  - Arrow key movement,
  - Home/End where applicable,
  - Enter/Space activation,
  - Escape dismissal,
  - Tab and Shift+Tab order,
  - focus trap for dialogs/sheets/alert dialogs,
  - focus restoration to trigger.
- Add accessible-name assertions for component root/trigger/content/input.
- Validate required ARIA relationships:
  - `aria-controls`,
  - `aria-expanded`,
  - `aria-activedescendant`,
  - `aria-selected`,
  - `aria-invalid`,
  - `aria-describedby`,
  - label/input relationships.

Acceptance criteria:

- A component that passes axe but breaks keyboard interaction fails browser QA.
- Overlay focus is verified before and after Escape/outside click.
- Form and data-rich keyboard behaviors are component-owned.

Verification commands:

```bash
npm run verify:uifn-browser -- --scope a11y
npm run verify:uifn-overlays -- --route /components/dialog/qa/focus-trap
npm run verify:uifn-browser -- --profile keyboard
```

### FIX-011: Strengthen static, layout, feedback, typography, and token checks

- Priority: P1
- Audit findings: `QA-006`, `QA-008`
- Problem: static/feedback/layout/typography behavior is mostly inferred from nonblank render, root geometry, and axe. It does not directly prove token application, stable dimensions, no text overlap, or semantic role matrices.
- Affected areas:
  - `uifn/examples/browser-qa/src/assertions/geometry.mjs`
  - `uifn/examples/browser-qa/src/assertions/visual.mjs`
  - `scripts/verify-uifn-components.mjs`
  - component stories and workbench fixtures

Required work:

- Add assertions for:
  - CSS variable/theme token presence,
  - contrast-relevant foreground/background pair availability,
  - stable dimensions for fixed-format controls,
  - no text overlap,
  - no text clipping,
  - expected semantic roles for static/feedback/layout components,
  - placeholder/skeleton semantics,
  - progress/loading state semantics.
- Add fixtures for long labels, narrow mobile widths, high contrast themes, and dense layouts.

Acceptance criteria:

- Long labels do not overlap or overflow in supported viewports.
- Theme-token regressions fail.
- Static/feedback components have explicit semantic evidence beyond text length.

Verification commands:

```bash
npm run verify:uifn-browser -- --profile static
npm run verify:uifn-browser -- --profile feedback
npm run verify:uifn-browser -- --profile layout
npm run verify:uifn-visual
```

### FIX-012: Make product scenarios real workflows

- Priority: P1
- Audit findings: `WB-004`
- Problem: scenarios exist and cover all components, but they are mostly generated cards/links. They do not yet behave like rich product workflows.
- Affected areas:
  - `uifn/examples/shared/src/scenario-inventory.ts`
  - `uifn/examples/shared/src/workbench-model.ts`
  - framework workbench renderers
  - browser QA scenario assertions

Required work:

- Upgrade the three scenarios into actual connected workflows:
  - settings console,
  - operations dashboard,
  - command center.
- Each scenario should have meaningful state transitions across several components.
- Add scenario-specific browser assertions:
  - settings update flow,
  - table/filter/action flow,
  - command/search/action flow,
  - modal/overlay from scenario context,
  - toast/feedback state,
  - responsive behavior.
- Ensure scenarios still cover all 45 components across the scenario set.

Acceptance criteria:

- Scenario QA fails if component actions do not update scenario state.
- Scenario pages remain human-readable examples, not only hidden test fixtures.
- Scenario coverage manifest still proves all components are included.

Verification commands:

```bash
npm run verify:uifn-browser -- --family scenario
npm run verify:uifn-examples
npm run verify:uifn-release
```

### FIX-013: Add pattern-specific behavior assertions

- Priority: P1
- Audit findings: `QA-009`
- Problem: patterns are inventoried and render model cards, but browser QA mainly checks action visibility and metadata.
- Affected areas:
  - `uifn/examples/shared/src/pattern-inventory.ts`
  - `uifn/examples/browser-qa/src/runner.mjs`
  - new pattern assertion helpers

Required work:

- Define expected behavior per pattern:
  - actions available,
  - table/filter/sort where relevant,
  - picker selection,
  - upload shell state,
  - billing card selection,
  - empty/loading/error states.
- Add route fixtures for pattern states.
- Assert real rendered pattern DOM instead of only model-card metadata.

Acceptance criteria:

- Broken pattern action/state behavior fails with a pattern-specific error code.
- Pattern evidence records the user-visible state transition that was tested.

Verification commands:

```bash
npm run verify:uifn-browser -- --family pattern
npm run verify:uifn-patterns
```

### FIX-014: Add SF panel fake-client and offline behavior assertions

- Priority: P1
- Audit findings: `QA-009`, `SEC-001`
- Problem: SF panels report injected fake clients through metadata but do not prove runtime no-network or fake-client method calls with route-level interception.
- Affected areas:
  - `uifn/examples/shared/src/sf-inventory.ts`
  - `uifn/examples/browser-qa/src/runner.mjs`
  - SF fake client implementations in framework apps or shared examples
  - network assertion helper from FIX-006

Required work:

- Add fake-client call counters and deterministic responses.
- Assert each SF panel calls only its injected fake client.
- Assert zero live network calls through runtime interception.
- Add state-specific SF panel tests:
  - loading,
  - empty,
  - success,
  - error,
  - action mutation.

Acceptance criteria:

- Replacing the fake client with a real network call fails browser QA.
- Missing fake-client call evidence fails SF panel QA.
- SF route evidence includes measured `liveNetworkCalls: 0`.

Verification commands:

```bash
npm run verify:uifn-browser -- --family sf
npm run verify:uifn-sf
npm run verify:uifn-release
```

### FIX-015: Add deterministic locale/timezone/date behavior assertions

- Priority: P1
- Audit findings: determinism invariants, `QA-005`
- Problem: calendar/date-picker props are fixed, but browser assertions do not prove timezone/locale/min/max/disabled/keyboard behavior.
- Affected areas:
  - calendar/date-picker fixtures
  - browser data-rich assertions
  - Playwright launch/context options

Required work:

- Set deterministic timezone/locale in browser context.
- Add fixtures for:
  - selected date,
  - disabled date,
  - min/max date,
  - keyboard navigation,
  - month transition,
  - high contrast theme.
- Assert rendered labels and selected state are stable across frameworks.

Acceptance criteria:

- Calendar/date-picker evidence includes timezone/locale, selected date, disabled date, and active cell.
- A date rendered differently across frameworks fails parity checks.

Verification commands:

```bash
npm run verify:uifn-browser -- --slug calendar
npm run verify:uifn-browser -- --slug date-picker
```

### FIX-016: Update docs to match stronger QA semantics

- Priority: P2
- Audit findings: `DOC-001` pass, follow-up required after changes
- Problem: docs currently describe the Workbench commands and routes. After fixing QA semantics, docs must explain the stronger behavior, artifacts, sharding, baselines, and release requirements.
- Affected areas:
  - `uifn/README.md`
  - `uifn/examples/README.md`
  - framework workbench READMEs
  - any browser QA docs under `uifn/.conduct/SFN-15`

Required work:

- Document:
  - component-owned assertions,
  - multi-profile filters,
  - overlay content checks,
  - runtime network interception,
  - visual baseline flow,
  - sharding/progress flags,
  - full release coverage.
- Remove any language implying probe-backed checks prove component behavior.

Acceptance criteria:

- `verify:uifn-docs` passes.
- Docs include examples for focused component, profile, shard, visual, and release runs.

Verification commands:

```bash
npm run verify:uifn-docs
npm run verify:uifn-examples
```

## Recommended Implementation Order

1. FIX-003 Multi-profile contracts and route filtering.
2. FIX-001 Form component-owned assertions.
3. FIX-002 Data-rich component-owned assertions.
4. FIX-004 Overlay content assertions.
5. FIX-006 Runtime network interception.
6. FIX-009 Canonical evidence normalization.
7. FIX-008 Progress, sharding, and timeout diagnostics.
8. FIX-005 Visual baseline/text-overlap/clipping checks.
9. FIX-010 A11y/keyboard depth.
10. FIX-011 Static/layout/token checks.
11. FIX-013 Pattern-specific behavior.
12. FIX-014 SF fake-client behavior.
13. FIX-015 Deterministic date/timezone behavior.
14. FIX-012 Product workflow scenarios.
15. FIX-007 Full release integration.
16. FIX-016 Documentation refresh.

Release integration should come after the major assertion fixes so the release gate does not merely run a larger shallow matrix. Documentation should be updated last, after final command names, evidence fields, and artifact paths stabilize.

## Global Acceptance Criteria

The audit findings are fixed only when all of the following are true:

- `npm run verify:uifn-examples` passes.
- `npm run verify:uifn-browser` passes with full component, pattern, SF, scenario, fixture, framework, profile, theme, and viewport coverage required by the spec.
- `npm run verify:uifn-overlays` passes and includes `select`.
- `npm run verify:uifn-workbench` passes and aggregates static plus complete browser evidence.
- `npm run verify:uifn-release` passes and includes complete Workbench browser coverage, not only smoke plus overlays.
- Browser evidence proves actual component behavior, not generic sidecar probes.
- Runtime network evidence proves zero live network calls for examples, patterns, and SF panels.
- Visual evidence catches nonblank-but-wrong rendering.
- Long-running gates emit progress and support deterministic sharding.
- Failure evidence includes stable codes, route/framework/slug/profile context, sanitized artifacts, and enough detail to reproduce locally.

## Required Regression Checks

Run from repository root:

```bash
npm --workspace @uifn/examples-shared run build
npm --workspace @uifn/components run test
npm run verify:uifn-examples
npm run verify:uifn-browser
npm run verify:uifn-overlays
npm run verify:uifn-workbench
npm run verify:uifn-docs
npm run verify:uifn-secrets
npm run verify:uifn-release
git diff --check
```

Focused checks that must no longer be false positives:

```bash
npm run verify:uifn-overlays -- --slug select
npm run verify:uifn-browser -- --framework react --slug input-otp --route /components/input-otp/qa/form-submit
npm run verify:uifn-browser -- --framework solid --slug data-table --route /components/data-table/qa/large-data
npm run verify:uifn-overlays -- --framework react --slug dropdown-menu --route /components/dropdown-menu/qa/edge-bottom-right
npm run verify:uifn-browser -- --framework svelte --slug calendar --route /components/calendar/qa/themes --scope visual
```

## Notes

- The existing Workbench breadth should be preserved. This inventory is not a request to discard the current route generation, framework apps, inventories, or browser runners.
- The main failure mode to remove is "checkbox completion": route exists, browser opens, screenshot is nonblank, but actual component behavior is not proven.
- Breaking changes are allowed because `uifn` is pre-adoption in this branch.
- Coss remains a capability/reference target only; no code copying is implied by these fixes.
