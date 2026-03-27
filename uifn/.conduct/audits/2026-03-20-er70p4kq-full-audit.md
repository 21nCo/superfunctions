## Metadata

- Timestamp: `2026-03-20T09:35:26Z`
- Agent name: `audit`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/uifn`
- OS + shell: `Darwin Mac 25.3.0 arm64`, shell `/bin/zsh`
- Repo metadata: git repo detected at `/Users/serro/Documents/dev/n/superfunctions`; branch `next`; commit `6f9a47d6c5f8ac166932e0156efb910bf5e32652`; dirty worktree `yes`
- Intent/notes paths audited:
  - User request in conversation: full production-readiness audit of `uifn`, report required under `uifn/.conduct`
  - `/Users/serro/Documents/dev/n/superfunctions/AGENTS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/react/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/README.md`
- Spec bundle paths audited:
  - Bundle root: `/Users/serro/Documents/dev/n/superfunctions/uifn`
  - Included files: `uifn/.conduct/SPEC.md`
  - Expected-but-absent bundle files: `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, `INTENT_AUDIT.md`
- Codebase scope audited:
  - In scope: `/Users/serro/Documents/dev/n/superfunctions/uifn/core`, `/Users/serro/Documents/dev/n/superfunctions/uifn/react`, `/Users/serro/Documents/dev/n/superfunctions/uifn/vue`, `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte`, `/Users/serro/Documents/dev/n/superfunctions/uifn/files`
  - Excluded from behavioral audit: `**/node_modules/**`, `**/.turbo/**`
  - Inspected as packaging evidence only: `**/dist/**`
- Commands executed during audit:
  - Repository/document inventory via `rg`, `find`, `sed`, `nl`, `wc`
  - Repo metadata via `git status --short --branch`, `git rev-parse HEAD`
  - Environment metadata via `uname -a`, `date -u`
  - Verification via `npm test -- --run`, `npm run build`, `npm run lint`, `npm ls ...`, `npm pack --dry-run`

## Audit scope

This was a read-only audit of the `uifn` function area for production readiness against the user’s request, the repository guidance in `AGENTS.md`, the top-level `uifn/.conduct/SPEC.md`, and the package READMEs that currently act as user-facing intent docs. No implementation code was changed.

Dynamic verification was performed where possible. Static analysis was used for behavior not directly exercised by the existing test surface. Manual browser QA, screen-reader QA, and downstream consumer app smoke tests were not performed, so any statement that depends on those is called out as an inference or limitation.

Overall verdict: `uifn` is **not production ready**. The package set has publish-surface inconsistencies, broken or missing quality gates, major spec underdelivery in the core layer, and a Svelte adapter that is not releasable in its current form.

## Inputs audited (intent + spec bundles)

| Input | Type | Role in audit | Notes |
| --- | --- | --- | --- |
| Conversation request | Intent | Authoritative request for a full production-readiness audit and report location | Required audit/report output under `uifn/.conduct` |
| `/Users/serro/Documents/dev/n/superfunctions/AGENTS.md` | Intent/constraints | Monorepo conventions, artifact location, naming/package expectations | Relevant for packaging, docs, and artifact placement |
| `uifn/.conduct/SPEC.md` | Spec bundle | Primary specification for `uifn` primitives | No accompanying requirements/test-vectors bundle found |
| `/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md` | Intent/docs | Public contract for core package naming, install path, API, license | Conflicts with package metadata |
| `/Users/serro/Documents/dev/n/superfunctions/uifn/react/README.md` | Intent/docs | Public contract for React adapter components, accessibility, types, license | Broadly aligns with exported surface, but overstates readiness |
| `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/README.md` | Intent/docs | Public contract for Vue adapter API and accessibility | Conflicts with implementation shape |
| `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/README.md` | Intent/docs | Public contract for Svelte adapter components, types, accessibility, license | Conflicts with pack output and test readiness |

## High-level findings

1. `uifn` is blocked at the publish surface. The core package is published as `uifn`, while the READMEs and adapter dependencies treat it as `@uifn/core`, and the core export map omits `./aria/*` even though React imports `@uifn/core/aria/keys` directly. This already breaks the React test suite and would break consumers following the documented import paths.
2. The Svelte adapter is not releasable. `npm test -- --run` fails before tests start because `@sveltejs/vite-plugin-svelte@5.1.1` expects Vite 6 while the resolved tree contains Vite 5, the package advertises `dist/index.d.ts` but the build disables declaration output, and the pack dry-run publishes raw source and test files.
3. The core layer does not implement the behavior promised by `uifn/.conduct/SPEC.md`. Many “framework-agnostic primitives” are only thin state bags with a few setters, leaving keyboard navigation, collision detection, submenu behavior, focus management, typeahead, queueing, reduced-motion handling, and other specified features to partial adapter code or not implemented at all.
4. Quality gates are insufficient or broken. `uifn/core` has no tests, every package’s `lint` script fails because there is no ESLint 9 flat config, the only explicit React a11y test is both skipped and written with broken imports, and there is no verified screen-reader or reduced-motion coverage.
5. Public docs and release metadata contradict one another. The Vue README promises composables that do not exist, README licenses say `Apache-2.0` while all package manifests say `MIT`, and public packages/components such as `Avatar`, `Badge`, `Menu Bar`, `Virtualized List`, and `@uifn/files` are outside the formal spec.

Package gate summary:

| Package | Build | Test | Lint | Pack dry-run | Audit note |
| --- | --- | --- | --- | --- | --- |
| `uifn/core` | PASS | FAIL | FAIL | PASS | No test files; export surface inconsistent with README/imports |
| `@uifn/react` | PASS with export warnings | FAIL | FAIL | PASS | Broken a11y test import and broken `@uifn/core/aria/keys` export path |
| `@uifn/vue` | PASS with export warnings | PASS | FAIL | Not run | Best current adapter gate result, but docs/API still conflict |
| `@uifn/svelte` | PASS with many reactivity warnings | FAIL | FAIL | PASS with bad contents | Missing types, invalid Vite/plugin matrix, ships source/tests |
| `@uifn/files` | PASS | PASS | No lint script | PASS with bad contents | Publishes compiled tests; undocumented and unspecced in `uifn` |

## Intent Inventory

1. `uifn` should be a framework-agnostic, accessible, unstyled primitives library for building design systems and component libraries.
2. The function should provide a reusable core plus framework adapters for React, Vue, and Svelte, and the spec also signals future Solid and web-components support.
3. The core layer should expose primitives, utilities, ARIA helpers, and state-machine infrastructure with minimal dependencies and reusable non-framework logic.
4. Stateful primitives should support both controlled and uncontrolled modes.
5. Public APIs should use composable/compound-component patterns and expose styling hooks such as data attributes.
6. Package metadata, install commands, docs, and TypeScript surfaces should be accurate for consumers.
7. Accessibility is a first-class requirement: WCAG 2.1 AA, keyboard patterns, screen-reader support, focus management/trapping/return, visible focus hooks, and reduced-motion respect.
8. The architecture should include state machines for complex components, immutable/event-driven state transitions, a custom event system, and SSR-safe/deterministic ID utilities.
9. Accordion should support single/multiple modes, collapsibility, value control, and keyboard navigation.
10. Alert Dialog and Dialog should support trigger/portal/overlay/content/title/description flows, focus management, escape behavior, dismissal policies, and scroll locking.
11. Checkbox, Switch, Toggle, Toggle Group, and Radio Group should support ARIA semantics, keyboard interaction, form integration, and disabled/required behavior.
12. Combobox and Select should support filtering/typeahead, highlight/selection state, grouping, form integration, and accessible popup behavior.
13. Context Menu, Dropdown Menu, Menu Bar, and Toolbar should support menu semantics, keyboard navigation, orientation, grouping, and viewport-aware positioning.
14. Hover Card, Popover, and Tooltip should support trigger modalities, delays, positioning, and appropriate accessibility/dismissal behavior.
15. Progress, Slider, Scroll Area, Separator, Label, Avatar, Badge, and Virtualized List should satisfy the behaviors promised by the spec and READMEs.
16. Utility surfaces should include portal, presence, position, focus, roving focus, and stable public exports that match consumer imports.
17. The test strategy should include unit, integration, and accessibility coverage across the public surface.
18. Release readiness requires working build/test/lint commands, pack hygiene, consistent package names/licenses/exports, and no contradictory docs.
19. `@uifn/files` is a public package under `uifn` scope and therefore also requires documentation, packaging hygiene, and spec alignment.

## Intent → Spec coverage matrix

| Intent # | Intent summary | Spec mapping | Coverage status | Notes |
| --- | --- | --- | --- | --- |
| 1 | Framework-agnostic, accessible, unstyled primitives library | `uifn/.conduct/SPEC.md:5-35` | COVERED | Core contract is stated explicitly |
| 2 | Core + React/Vue/Svelte plus future Solid/web-components adapters | `uifn/.conduct/SPEC.md:5`, `uifn/.conduct/SPEC.md:12`, `uifn/.conduct/SPEC.md:62-66` | COVERED | Spec explicitly names Solid and web-components, even though code does not implement them |
| 3 | Core primitives/utils/aria/state with reusable logic | `uifn/.conduct/SPEC.md:42-58`, `uifn/.conduct/SPEC.md:71-74` | COVERED | Architecture is specified |
| 4 | Controlled and uncontrolled modes | `uifn/.conduct/SPEC.md:74`, `uifn/.conduct/SPEC.md:783-788` | COVERED | Global pattern is specified |
| 5 | Compound composition + styling hooks/data attributes | `uifn/.conduct/SPEC.md:27-29`, `uifn/.conduct/SPEC.md:789-822` | COVERED | Explicitly specified |
| 6 | Accurate docs, installability, TypeScript-first DX | `uifn/.conduct/SPEC.md:30-35` | PARTIAL | TypeScript/docs intent is present; package naming/docs accuracy is not specified in enough detail |
| 7 | Accessibility baseline including reduced motion | `uifn/.conduct/SPEC.md:18-22`, `uifn/.conduct/SPEC.md:846-894` | COVERED | Accessibility baseline is strongly specified |
| 8 | State machines, immutable/event-driven state, custom events, SSR-safe IDs | `uifn/.conduct/SPEC.md:71-82`, `uifn/.conduct/SPEC.md:858-873` | COVERED | All of these are explicitly promised |
| 9 | Accordion behavior | Accordion section in `uifn/.conduct/SPEC.md` | COVERED | Component contract present |
| 10 | Dialog/Alert Dialog behavior | Alert Dialog + Dialog sections in `uifn/.conduct/SPEC.md` | COVERED | Component contracts present |
| 11 | Form-control primitives behavior | Checkbox, Switch, Toggle, Toggle Group, Radio Group sections | COVERED | Component contracts present |
| 12 | Combobox and Select behavior | Combobox + Select sections | COVERED | Component contracts present |
| 13 | Menus and toolbar behavior | Context Menu, Dropdown Menu, Toolbar sections | PARTIAL | `Menu Bar` is exported publicly but not specified in `uifn/.conduct/SPEC.md` |
| 14 | Hover Card, Popover, Tooltip behavior | Hover Card, Popover, Tooltip sections | COVERED | Component contracts present |
| 15 | Progress/Slider/Scroll/Separator/Label plus Avatar/Badge/Virtualized List | Relevant component sections + README component lists | PARTIAL | `Avatar`, `Badge`, and `Virtualized List` are public, but not specified in `uifn/.conduct/SPEC.md` |
| 16 | Utility surfaces must be public and stable | `uifn/.conduct/SPEC.md:828-873` | COVERED | Utilities are specified |
| 17 | Unit/integration/a11y testing expectations | `uifn/.conduct/SPEC.md:901-915` | COVERED | Testing expectations are explicit |
| 18 | Release-readiness expectations for package names/licenses/export maps/scripts/pack output | No direct coverage in `uifn/.conduct/SPEC.md` | SPEC MISSING | This matters to production readiness but is not formalized in the spec |
| 19 | `@uifn/files` must be documented and spec-aligned if public | No direct coverage in `uifn/.conduct/SPEC.md` | SPEC MISSING | Public package exists with no matching `uifn` spec/README coverage |

## Requirement coverage summary

The only formal spec bundle found for `uifn` was `uifn/.conduct/SPEC.md`, so the requirement inventory below is derived from that document’s sections.

| Spec bundle | Derived requirements | PASS | PARTIAL | FAIL | UNVERIFIED |
| --- | --- | --- | --- | --- | --- |
| `uifn/.conduct/SPEC.md` | 38 | 4 | 22 | 12 | 0 |

Verification summary by package:

| Command | Result |
| --- | --- |
| `npm test -- --run` in `uifn/core` | FAIL: no test files found |
| `npm test -- --run` in `uifn/react` | FAIL: 4 suites fail; broken import in `accordion.a11y.test.tsx` and missing `./aria/keys` export |
| `npm test -- --run` in `uifn/vue` | PASS: 17 test files, 20 tests |
| `npm test -- --run` in `uifn/svelte` | FAIL: config load error from invalid Vite/Svelte plugin matrix |
| `npm test -- --run` in `uifn/files` | PASS: 1 file, 38 tests |
| `npm run build` in `uifn/core` | PASS |
| `npm run build` in `uifn/react` | PASS with `types` export-order warnings |
| `npm run build` in `uifn/vue` | PASS with `types` export-order warnings |
| `npm run build` in `uifn/svelte` | PASS with widespread `state_referenced_locally` warnings |
| `npm run build` in `uifn/files` | PASS |
| `npm run lint` in `uifn/core/react/vue/svelte` | FAIL in all four packages: no `eslint.config.*` for ESLint 9 |

## Requirement-by-requirement results

### Platform and architecture requirements

| ID | Derived requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R01 | Overview contract: framework-agnostic, accessible, unstyled library | PARTIAL | `uifn/.conduct/SPEC.md:5-35`; packages exist for core/react/vue/svelte | The package family exists, but accessibility and framework-agnostic claims are not met at spec depth |
| R02 | Adapter coverage for React/Vue/Svelte/Solid/web-components | FAIL | Only `core`, `react`, `vue`, `svelte`, `files` directories exist under `uifn` | Solid and web-components are absent; public scope also includes an unspecced `files` package |
| R03 | Minimal dependencies and reusable pure/state-machine logic | PARTIAL | Core is TypeScript-only, but many complex behaviors are reimplemented in adapters | Only `collapsible` uses the state-machine utility; core is not the behavioral source of truth |
| R04 | Accessibility-first baseline (WCAG AA, keyboard, screen-reader, focus, reduced motion) | FAIL | Broken/skipped a11y test, no reduced-motion code found, sparse manual coverage | Spec-grade accessibility is not substantiated |
| R05 | Unstyled-by-default design | PARTIAL | Many primitives are structurally unstyled; React/Vue dialog layers ship inline styles | Inline overlay/content styling weakens the “zero styling opinions” claim |
| R06 | Composable architecture / compound components | PARTIAL | React/Vue/Svelte component families exist | Svelte controlled props are explicitly not synced; composition is not equally trustworthy across adapters |
| R07 | Developer experience: installability, docs accuracy, TS definitions | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md:1-18`, `/Users/serro/Documents/dev/n/superfunctions/uifn/core/package.json:2-24`, `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/package.json:5-15`, `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/tsup.config.ts:4-8` | Docs and package metadata contradict each other, and Svelte does not ship the declared types file |
| R08 | Core layer exposes primitives, utils, aria, and state | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/index.ts:1-4`, `/Users/serro/Documents/dev/n/superfunctions/uifn/core/package.json:8-23` | `aria` and `state` exist on disk, but root exports and export map omit them |
| R09 | State management should be state-machine-driven, immutable, and event-driven | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/state/machine.ts:30-98`, primitive files below | Context is mutated in place, only a minority of primitives use the machine, and no custom event model exists |
| R10 | Custom event system for cross-framework compatibility | FAIL | No implementation found in `uifn/core/src` or adapter sources | Spec promise is absent in code |

### Component requirements

| ID | Derived requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R11 | Accordion | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/accordion.ts:27-90`; React/Vue/Svelte tests exist but React is broken by roving-focus import | Basic value toggling exists; keyboard/a11y verification is incomplete |
| R12 | Alert Dialog | PARTIAL | Adapter implementations and tests exist; core primitive is minimal open-state logic | Focus and dismissal behavior vary by adapter; spec promises exceed shared implementation |
| R13 | Checkbox | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/checkbox.ts:1-51`; adapter tests exist | Basic checked/indeterminate behavior works; form integration is simplified and adapter-specific |
| R14 | Collapsible | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/collapsible.ts:1-38` | Best use of the state machine, but adapter coverage/testing is thin |
| R15 | Combobox | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/combobox.ts:1-77` | Core lacks multiple selection, highlighted index, filter application, and virtual scrolling behavior from the spec |
| R16 | Context Menu | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/context-menu.ts:1-48` | Core only tracks `open/x/y`; submenu, checkbox/radio items, and collision behavior are absent |
| R17 | Dialog | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/dialog.ts:1-58`; React/Vue/Svelte adapters exist | Shared core does not model focus, outside click, modal rules, or scroll lock |
| R18 | Dropdown Menu | PARTIAL | Adapter implementations exist; shared primitive coverage is minimal | Menus work at basic level, but spec-level keyboard/submenu behavior is not fully established |
| R19 | Hover Card | PARTIAL | React/Vue/Svelte implementations exist | Delay and open-state behavior exist; positioning and broader accessibility guarantees are partial |
| R20 | Label | PASS | Simple label implementations exist in all adapters | Low-complexity contract appears satisfied |
| R21 | Popover | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/popover.ts:1-42`; adapters add more behavior | Shared implementation is only open-state tracking; positioning/collision is adapter-side only |
| R22 | Progress | PASS | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/progress.ts:1-43`; tests pass | Contract is simple and substantially implemented |
| R23 | Radio Group | PARTIAL | Adapter implementations exist; React tests blocked by roving-focus export gap | Base behavior exists, but roving-focus/keyboard contract is not robustly verified |
| R24 | Scroll Area | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/scroll-area.ts:1-15` | Core does not implement scroll synchronization, thumb behavior, or corner logic promised by spec |
| R25 | Select | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/select.ts:1-61` | Core omits typeahead, grouped options behavior, item navigation, and positioning logic |
| R26 | Separator | PASS | Simple separator components exist | Low-complexity contract appears satisfied |
| R27 | Slider | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/slider.ts:1-61`; tests exist | Basic clamping/value behavior exists; multiple-thumb and advanced orientation semantics are incomplete |
| R28 | Switch | PARTIAL | Adapter implementations and tests exist | Basic contract is present; form/hidden-input semantics are simplified |
| R29 | Tabs | PARTIAL | Adapter implementations and tests exist; React roving-focus import issue breaks some suites | Basic tab selection exists; activation-mode/focus behavior is not uniformly verified |
| R30 | Toast | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/toast.ts:1-70`; adapter tests exist | Timer behavior exists, but queueing, placement variants, and richer semantics are missing in core |
| R31 | Toggle | PASS | Simple pressed-state implementations and tests exist | Low-complexity contract appears satisfied |
| R32 | Toggle Group | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/toggle-group.ts:1-86` | Basic single/multiple selection exists; roving/tab behavior is simplified |
| R33 | Toolbar | PARTIAL | Adapter implementations and tests exist | Basic orientation semantics are there; spec-level keyboard navigation depth is incomplete |
| R34 | Tooltip | PARTIAL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/primitives/tooltip.ts:1-64`; adapter tests exist | Delay behavior exists, but skip-delay, reduced-motion, and broader accessibility guarantees are partial |

### Cross-cutting requirements

| ID | Derived requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R35 | Controlled/uncontrolled common pattern across stateful components | PARTIAL | `uifn/.conduct/SPEC.md:783-788`; `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/src/Accordion.svelte:28-33` | React/Vue mostly implement it; Svelte explicitly documents that controlled props are not really synchronized |
| R36 | Data attributes and polymorphic/asChild support | FAIL | Data attributes are common; `/Users/serro/Documents/dev/n/superfunctions/uifn/react/src/dialog.tsx:74-84` | Data attributes exist, but spec-level polymorphism is not delivered; React still has `TODO` for `asChild` |
| R37 | Utilities: focus, portal, presence, position, IDs, roving focus | FAIL | `/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/utils/id.ts:1-5`, `/Users/serro/Documents/dev/n/superfunctions/uifn/react/src/hooks/use-roving-focus.ts:1-73`, `/Users/serro/Documents/dev/n/superfunctions/uifn/core/package.json:8-23`, `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/src/hooks/use-id.ts:3-8` | ID generation violates SSR-safe/deterministic spec, public exports do not match consumer imports, and utility coverage is inconsistent across adapters |
| R38 | Unit, integration, and accessibility testing strategy | FAIL | Dynamic verification results above; `/Users/serro/Documents/dev/n/superfunctions/uifn/react/src/accordion.a11y.test.tsx:1-23`; `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/src/test/setup.ts:1-10` | Core has no tests, React a11y test is broken/skipped, Svelte tests do not start, and manual screen-reader coverage is absent |

Per-requirement notes:

- The biggest pattern across the component matrix is that the core package rarely owns the complex behavior promised by the spec. Instead, adapters contain partial DOM-level behavior, which undermines the “framework-agnostic core” goal.
- The few PASS results correspond to very low-complexity primitives whose contract is mostly structural (`Label`, `Separator`, `Toggle`) or numerically straightforward (`Progress`).
- Many PARTIAL results mean “the component exists and basic tests pass” rather than “the full spec is met.” In most cases, keyboard depth, positioning, reduced-motion behavior, or packaging guarantees remain incomplete.

## Spec conflicts / spec gaps

1. **Core package identity conflict**
   - README and consumer docs say `@uifn/core` (`/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md:1-18`).
   - Package manifest publishes `uifn` (`/Users/serro/Documents/dev/n/superfunctions/uifn/core/package.json:2`).
   - React/Vue/Svelte depend on `@uifn/core`, which only works in this workspace via aliasing; the public publish story is inconsistent.

2. **Core exports conflict with documented/public imports**
   - `uifn/core/src/index.ts` comments out `state` and `aria` exports (`/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/index.ts:1-4`).
   - `uifn/core/package.json` export map omits `./aria/*` and `./state/*` (`/Users/serro/Documents/dev/n/superfunctions/uifn/core/package.json:8-23`).
   - React imports `@uifn/core/aria/keys` directly (`/Users/serro/Documents/dev/n/superfunctions/uifn/react/src/hooks/use-roving-focus.ts:2`), causing test failures.

3. **Vue docs conflict with implementation shape**
   - Vue README promises composables such as `useCheckbox` and `useDialog` (`/Users/serro/Documents/dev/n/superfunctions/uifn/vue/README.md:13-36`).
   - Actual package exports component modules (`/Users/serro/Documents/dev/n/superfunctions/uifn/vue/src/index.ts:1-27`).

4. **License conflict**
   - All `uifn` package manifests say `MIT`.
   - All package READMEs audited say `Apache-2.0` (`uifn/core/README.md:52`, `uifn/react/README.md:72`, `uifn/vue/README.md:52`, `uifn/svelte/README.md:70`).

5. **Public surface exceeds the formal spec**
   - `Avatar`, `Badge`, `Menu Bar`, `Virtualized List`, and the whole `@uifn/files` package are public, but they are not formalized in `uifn/.conduct/SPEC.md`.
   - This is a spec gap, not just an implementation gap.

6. **Release-readiness concerns are largely unspec’d**
   - `uifn/.conduct/SPEC.md` says little about package names, export maps, pack contents, lint/tooling baselines, or compatibility matrices.
   - Those omissions matter materially for production readiness.

## Cross-cutting audits

### Security/authz/validation boundaries

- No privileged server-side auth/authz boundary exists inside `uifn`; the primary risks are client-side contract correctness and safe defaults, not authorization bypass.
- `@uifn/files` performs convenience filtering but does not enforce any hard file-count, byte-size, or quota limits. It should not be treated as a policy boundary.
- Error/invariant handling is mostly ad hoc. Components typically throw generic “must be used within” errors or silently no-op when disabled.

### Determinism invariants

- The spec explicitly promises SSR-safe and deterministic IDs (`uifn/.conduct/SPEC.md:862-863`), but the implementation does not satisfy that:
  - Core `generateId` is a process-global counter (`/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/utils/id.ts:1-5`).
  - Vue `useId` uses `Math.random()` (`/Users/serro/Documents/dev/n/superfunctions/uifn/vue/src/hooks/use-id.ts:3-8`).
  - React `useId` falls back to client-only `useLayoutEffect` generation when `React.useId` is unavailable (`/Users/serro/Documents/dev/n/superfunctions/uifn/react/src/hooks/use-id.ts:4-17`).
- The state-machine helper mutates context in place (`/Users/serro/Documents/dev/n/superfunctions/uifn/core/src/state/machine.ts:70-84`), so the spec’s immutable-update intent is not met.
- Svelte builds emit widespread `state_referenced_locally` warnings, and source comments admit that controlled props are effectively “MVP” snapshots (`/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/src/Accordion.svelte:28-33`).

### Limits/caps

- No formal limits are documented or enforced for item counts, overscan, menu depth, toast queue size, file count, or file size.
- `Virtualized List` exists only in React/Svelte adapter surfaces, not in the core spec as a first-class component contract.
- `@uifn/files` exposes helper-state abstractions but does not enforce throughput/storage ceilings beyond calculating percentages.

### Error handling + canonical envelopes

- There is no canonical error envelope or structured diagnostic surface across packages.
- Public components mix thrown runtime errors, silent no-ops, raw booleans, and ad hoc string statuses such as `invalid_plan`.
- The spec says nothing about stable error codes, migration-safe warnings, or consumer-facing failure modes.

### Compatibility/versioning/migrations

- `@uifn/svelte` is currently built against an invalid dependency tree: `npm ls vite @sveltejs/vite-plugin-svelte vitest` reports `@sveltejs/vite-plugin-svelte@5.1.1` requiring Vite 6 while Vite 5.4.21 is installed/resolved.
- React and Vue builds emit warnings that the `types` condition in `exports` will never be used because it comes after `import` and `require` (`uifn/react/package.json:8-13`, `uifn/vue/package.json:8-13`).
- No `CHANGELOG.md` files were found under `uifn/*`, so there is no visible migration/versioning story for public packages.
- Svelte and files pack output are not publish-clean:
  - `@uifn/svelte` packs source and test files and still omits declarations.
  - `@uifn/files` packs compiled tests (`dist/index.test.d.ts`, `dist/index.test.js`).

## Recommendations (ranked)

1. **Fix the public package contract before any release.**
   - References: Intent `2`, `6`, `16`, `18`; Requirements `R02`, `R07`, `R08`, `R37`
   - Choose one canonical identity for the core package, align README install instructions, make the export map match consumer imports, and correct the `types` export ordering.

2. **Make the Svelte adapter releasable or remove it from the advertised ready surface.**
   - References: Intent `2`, `4`, `6`, `16`, `17`, `18`; Requirements `R02`, `R06`, `R07`, `R35`, `R37`, `R38`
   - Fix the Vite/Svelte/Vitest compatibility matrix, enable declaration output, stop shipping tests/src unless deliberately part of the public surface, and resolve the reactivity warnings caused by prop snapshotting.

3. **Either implement the spec’s framework-agnostic core contract or reduce the spec to match reality.**
   - References: Intent `1`, `3`, `7`, `8`, `9-17`; Requirements `R03-R38`
   - The current gap is too wide to wave away as missing polish. Combobox, Select, Context Menu, Scroll Area, event system, deterministic IDs, reduced motion, and shared complex behavior need either real implementation or explicit de-scoping.

4. **Restore quality gates and make them meaningful.**
   - References: Intent `7`, `17`, `18`; Requirements `R04`, `R07`, `R38`
   - Add an ESLint 9 flat config, give `uifn/core` real tests, make a11y tests runnable, and add pack/install smoke tests to catch export-map and missing-types failures.

5. **Reconcile docs, licenses, and spec gaps.**
   - References: Intent `6`, `15`, `18`, `19`; Requirements `R07` plus spec-gap items
   - Fix the Vue README API model, harmonize license text, document `@uifn/files`, and either spec or remove public surfaces that are currently undocumented (`Avatar`, `Badge`, `Menu Bar`, `Virtualized List`, `files`).

6. **Clean package output and release hygiene.**
   - References: Intent `18`, `19`; Requirements `R07`, `R38`
   - Remove compiled tests from `@uifn/files`, reconsider shipping raw Svelte sources/tests, and add changelogs or release notes for public packages.

## Appendix: commands run + environment details

Environment details:

- Working directory: `/Users/serro/Documents/dev/n/superfunctions`
- Project audited: `/Users/serro/Documents/dev/n/superfunctions/uifn`
- Shell: `/bin/zsh`
- OS: `Darwin Mac 25.3.0 Darwin Kernel Version 25.3.0 arm64`
- Git branch: `next`
- Git commit: `6f9a47d6c5f8ac166932e0156efb910bf5e32652`
- Git dirty state: `yes`

Commands run during the audit:

| Command | Purpose | Outcome |
| --- | --- | --- |
| `rg --files uifn` | Inventory source/test/manifests | Confirmed `core/react/vue/svelte/files` package layout |
| `find uifn -maxdepth ...` | Inventory docs, hidden dirs, conduct state | Found `uifn/.conduct/SPEC.md` and per-package READMEs; no `uifn/.conduct` before audit |
| `sed -n ...`, `nl -ba ...`, `rg -n ...` | Read spec/docs/source/manifests with line references | Used throughout for evidence gathering |
| `git status --short --branch` | Repo metadata | Branch `next`, dirty worktree |
| `git rev-parse HEAD` | Repo metadata | Commit `6f9a47d6c5f8ac166932e0156efb910bf5e32652` |
| `uname -a && echo SHELL=$SHELL` | Environment metadata | Captured OS and shell |
| `npm test -- --run` in each `uifn/*` package | Dynamic verification | Core fail/no tests; React fail; Vue pass; Svelte fail-to-start; Files pass |
| `npm run build` in each `uifn/*` package | Dynamic verification | Core/React/Vue/Svelte/Files build, with warnings noted |
| `npm run lint` in `uifn/core`, `uifn/react`, `uifn/vue`, `uifn/svelte` | Quality-gate verification | All four fail due missing ESLint 9 flat config |
| `npm ls ...` in adapter packages | Dependency-matrix verification | Svelte tree invalid around Vite/plugin versions; React/Vue show version skew warnings |
| `npm pack --dry-run` in selected packages | Publish-surface verification | Confirmed missing Svelte types and leaked Files tests |
| `date -u`, random-id generation | Audit metadata | Produced timestamp and report id |

Static-audit limitations:

- No manual browser QA in real apps was performed.
- No NVDA/JAWS/VoiceOver verification was performed.
- No SSR application harness was executed, so SSR issues are inferred from code and pack metadata rather than demonstrated in an app integration.
