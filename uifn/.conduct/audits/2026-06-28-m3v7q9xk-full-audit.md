# SFN-15 uifn Full Audit

## Metadata

- Audit timestamp: 2026-06-28T03:10:48Z
- Audit id: 2026-06-28-m3v7q9xk
- Agent name: Droid
- Model: Claude Opus 4.8
- Launcher: Factory CLI
- Workspace: repo root, project scope `uifn`
- Shell/OS: zsh on Darwin
- Git branch: `SFN-15`
- Git upstream display: `sf-next/next`
- Git commit audited: `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Git status at audit time: dirty before this report was written, with SFN-15 implementation files modified/untracked across root scripts, package metadata, `uifn/.conduct/SFN-15`, and the `uifn/*` packages.

## Scope

User request: perform a thorough audit of the current `uifn` implementation against the `.conduct/SFN-15` spec, then record the findings as an audit report.

Intent and spec sources audited:

- `uifn/.conduct/SFN-15/README.md`
- `uifn/.conduct/SFN-15/INTENT_AUDIT.md`
- `uifn/.conduct/SFN-15/SPEC.md`
- `uifn/.conduct/SFN-15/REQUIREMENTS.md`
- `uifn/.conduct/SFN-15/PLAN.md`
- `uifn/.conduct/SFN-15/subspecs/*.md`
- `uifn/.conduct/SFN-15/phase-reports/*.md`

Implementation sources audited:

- `uifn/**`
- `scripts/verify-uifn-*.mjs`
- root `package.json` where it defines workspaces and release scripts

Generated/build output and dependency folders were not treated as source of truth. This audit independently re-derived findings from source and live verifier runs rather than relying on the phase reports. It largely confirms the prior audit `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md` and adds the React/Svelte surface-duplication nuance.

## Commands Run

- `git rev-parse HEAD`, `git status --short`, `git rev-parse --abbrev-ref HEAD`
- `node scripts/verify-uifn-package-graph.mjs`
- `node scripts/verify-uifn-catalog.mjs`
- `node scripts/verify-uifn-registry.mjs`
- `node scripts/verify-uifn-sf.mjs`
- `node scripts/verify-uifn-release.mjs --dry-run`
- targeted `grep`/`ls` over `uifn/registry/catalog`, `uifn/**`, and `scripts/verify-uifn-*.mjs`

## Executive Summary

The 19 SFN-15 phase reports and `uifn/.conduct/tracker.csv` mark the issue complete, and `npm run verify:uifn-release` returns `ok: true`. This is a false signal. The implementation is a broad, coherent scaffold plus a metadata-driven acceptance harness, not a production-ready SFN-15 system. The release "pass" is dominated by `planned`/`placeholder` statuses and static string/JSON checks that never execute framework, render, accessibility, or visual behavior.

Hard proof from a live run:

- `verify-uifn-release.mjs --dry-run` returns `ok: true` with 80 blocking checks, every check `status: "planned"`, `passed: 0`, `failed: 0`.
- The component catalog has 45 manifests, all `status: "planned"`, with 675 `placeholder` story/fixture/test sub-entries and 0 implemented.
- Files those manifests reference (component source, stories, tests) do not exist on disk.

The 16-package target architecture exists and the package graph verifier passes, but the behavioral layers (adapters conformance, styled components, registry source install, a11y/visual gates, theming) are placeholder, descriptor-level, or static-only.

## Top Findings

### P0 - Release gate produces false confidence (TEST-001, TEST-002)

`scripts/verify-uifn-release.mjs --dry-run` returns `ok: true` while listing 80 checks all at `status: "planned"` with zero execution. The behavioral verifiers it orchestrates are static:

- `scripts/verify-uifn-a11y.mjs` reads fixture/story JSON and checks booleans such as `fixture.a11y.keyboard` and `fixture.a11y.focusVisible`. It runs no browser, no axe, no ARIA assertions, and no focus traversal.
- `scripts/verify-uifn-visual.mjs` reads story/fixture JSON and checks matrix keys. It renders no snapshots and compares no pixels.
- `scripts/verify-uifn-adapter.mjs` checks required file presence and the presence of source-code substrings (for example `'DialogRoot'`), not rendered or hydrated behavior.

Impact: high. This violates the SFN-15 release-gate requirement that build, type, lint, unit, conformance, a11y, interaction, visual, SSR, pack, export-map, manifest, docs, token, Tailwind, and secret checks block false success.

Recommended fix: split metadata linting from behavioral gates; make `planned`/`placeholder` statuses fail the production track; require real browser/SSR/component/adapter execution evidence.

### P0 - Adapter conformance bypasses the real framework adapters (ADAPT-001 through ADAPT-006)

Every framework conformance entry uses the adapter-kit minimal fixture, which drives core controllers directly:

- `uifn/react/src/conformance/react-conformance.ts` uses `createMinimalFixtureAdapter('react')`.
- `uifn/svelte/src/conformance/svelte-conformance.ts`, `uifn/vue/.../vue-conformance.ts`, `uifn/solid/.../solid-conformance.ts`, and `uifn/angular/.../angular-conformance.ts` do the same for their frameworks.

In `uifn/adapter-kit/src/conformance.ts`, `createMinimalFixtureAdapter` builds a core fixture via `createDialogController` / `createCheckboxController` and triggers `part.handlers?.[event.type]`. The conformance suite therefore never exercises real React/Svelte/Vue/Solid/Angular rendering, hooks, actions, composables, signals, or directives, and covers only two primitives (dialog, checkbox).

Impact: high. Adapter conformance release evidence for ADAPT-001 through ADAPT-006 is invalid.

Recommended fix: replace the minimal fixture wiring with per-framework fixtures that render/instantiate the public API, expand vector coverage beyond dialog/checkbox, and make `verify-uifn-adapter.mjs` execute these suites and fail on drift.

### P0 - `@uifn/components` is descriptor-level, not a renderable styled library (COMP-001, COMP-002, COMP-003)

`uifn/components/src/index.ts` re-exports `shared/batch-a`, `shared/batch-b`, and `shared/data-rich`. These return descriptors, not components:

- `uifn/components/src/shared/batch-a.ts` `renderBatchAComponent(...)` returns `{ framework, component, tag, className, data, parts }`.
- `uifn/components/src/shared/data-rich.ts` returns `() => ({ framework, component, source: 'clean-room-controller' })`.

Data-rich components (Data Table, Calendar, Date Picker, Command, Sidebar, Resizable) carry the most behavior risk and have no real render, keyboard, virtualization, or a11y implementation in this package.

Impact: high. COMP-001, COMP-002, COMP-003, STORY-001, STORY-002, TEST-001, and TEST-002 cannot be considered satisfied by this package.

Recommended fix: implement renderable clean-room components per framework (or generate them from a shared headless contract), unify with the existing real React/Svelte components (see nuance below), and add tests that render the public API rather than asserting descriptor objects.

### P0 - Registry component manifests are placeholders, yet validation passes (REG-001, COMP-001)

A scan of `uifn/registry/catalog/components/*.json` (45 files) returns: 45 `status: "planned"`, 675 `placeholder` sub-entries, 0 implemented. `uifn/registry/catalog/components/button.json` is `status: "planned"` and lists story/fixture/test entries all `status: "placeholder"`. The referenced files do not exist, for example:

- `components/ui/react/button.tsx`
- `uifn/storybook/stories/components/button/*.stories.tsx`
- `uifn/components/src/button/button.render.test.tsx`

The registry schema requires field presence only; it does not reject `planned`/`placeholder`, nor verify referenced files exist or are executable. The catalog and registry verifiers report full coverage anyway.

Impact: high. Release-blocking mismatch with REG-001, COMP-001, STORY-001, STORY-002, TEST-001, and DOCS-001.

Recommended fix: make registry validation fail unless implementation status is allowed for the release mode, all referenced files exist, placeholder statuses are absent from GA paths, checksums are present, and tests/stories are executable.

### P1 - Core part-prop public API drift: `handlers` instead of `on` (CORE-002)

SFN-15 specifies `UIFnPartProps` with `on?: Record<string, UIFnEventHandler>`. The implementation ships `handlers?: UIFnPartEventHandlers` in `uifn/core/src/parts.ts`, and the drift propagates into `uifn/adapter-kit/src/conformance.ts` (`part.handlers?.[event.type]`) and the framework prop conversion paths.

Impact: medium-high. Public cross-framework contract drift that affects every adapter and any source-installed consumer.

Recommended fix: rename the public field to `on` and update adapters/tests, or formally amend the spec before GA. If a compatibility shim is needed, keep `handlers` internal only.

### P1 - SF-backed pattern coverage is 7 of 14 (SF-001, SF-002)

`scripts/verify-uifn-sf.mjs` enforces exactly 7 backed variants. The patterns subspec (`uifn/.conduct/SFN-15/subspecs/PATTERNS_AND_SUPERFUNCTIONS.md`) lists 14 phase-one backed variants: AuthFn x4, PlugFn x3, FileFn x4, BillFn x3. FileFn ships only `FileFnFileDropzonePanel`.

Missing relative to the subspec:

- `AuthFnSessionList`, `AuthFnUserProfileCard`
- `PlugFnWebhookEndpointTable`
- `FileFnUploadProgressList`, `FileFnFileListPanel`, `FileFnQuotaUsagePanel`
- `BillFnInvoiceTable`

Impact: medium-high. The high-level spec section and the detailed subspec disagree (7 vs 14); the implementation matches only the shorter list.

Recommended fix: reconcile the two spec lists, then implement and gate the authoritative backed-variant set.

### P1 - Solid adapter is a single primitive (ADAPT-005)

`uifn/solid/src` contains only `create-switch.ts` plus the Switch component and two hooks. The adapter verifier's Solid contract only requires the Switch files, so single-primitive coverage passes despite the "every primitive" requirement. Vue and Angular contracts are broader but still verified only by file/string presence.

Impact: medium-high. ADAPT-005 (and the breadth portion of ADAPT-004/ADAPT-006) is not met.

Recommended fix: implement the full primitive set for Solid (and verify Vue/Angular breadth) with executable conformance.

### P1 - Styling and theming are incomplete (STYLE-002, STYLE-003, STYLE-005)

First-party theme JSON (`uifn/theme/src/themes/uifn-light.json` and siblings) includes `surface`, `text`, `border`, and `accent`, but no `danger` / `warning` / `success` color groups or their per-theme contrast tokens. No `createBrandTheme(...)` implementation exists (only OKLCH helpers in `uifn/tokens/src/oklch.ts`). `validateThemeContrast` checks only a few hard-coded pairs rather than all non-decorative foreground/background pairs.

Impact: medium-high. STYLE-001/STYLE-002 partial; STYLE-003 and the contrast portion of TEST-002 incomplete; STYLE-005 unmet.

Recommended fix: implement `createBrandTheme`, add the status color groups with computed contrast tokens, attach foreground/background metadata, and validate all non-decorative pairs.

### P1 - Registry source install diverges from the detailed spec (REG-002)

`uifn/registry/src/lockfile.ts` writes `.uifn/lock.json`; the subspec (`REGISTRY_AND_CLI.md`) requires `.uifn/registry.lock` and `.uifn/selected-components.json`. `uifn/registry/src/diff.ts` supports only `missing`, `modified`, and `unchanged`, while the spec requires six states including checksum mismatch and unsupported local edit conflict. `uifn/registry/src/update.ts` overwrites via `addArtifact` without modeling local-edit conflicts first; `add.ts` writes thin metadata wrappers and placeholder stories/fixtures/tests rather than real source-installed component files.

Impact: medium-high. The CLI can install something, but not the source distribution and drift semantics SFN-15 promises.

Recommended fix: align lock/selection filenames with the spec, generate real source artifacts with provenance/checksums, and make `diff`/`update` conflict-safe.

### P2 - Two disconnected React/Svelte component surfaces (consistency / COMP-001)

`uifn/react/src/*.tsx` contains substantial real, pre-SFN-15 GA component implementations (Accordion, AlertDialog, Combobox, Dialog, DropdownMenu, Select, Slider, Toast, and more, with real tests) corresponding to the legacy 28-family release contract. These are not the SFN-15 `@uifn/components` 45-component catalog, are not wired into the new core controller model, and are bypassed by SFN-15 conformance. The SFN-15 `@uifn/components` package remains descriptor-only.

Impact: medium. Real component code exists but is not the SFN-15 catalog the spec requires, and it sits beside an unimplemented descriptor package, creating a split source of truth.

Recommended fix: unify the existing real React/Svelte components with the SFN-15 catalog and core controller model, then extend to Vue/Solid/Angular.

## Intent Coverage Matrix

The SFN-15 `INTENT_AUDIT.md` lists 38 intent items. Current implementation coverage:

| Intent area | Status | Notes |
| --- | --- | --- |
| Production-ready `uifn` package family | Partial | Family exists; several packages descriptor/metadata level. |
| Clean-room Coss-compatible catalog | Partial | 45 names cataloged; manifests planned/placeholder, components not renderable. |
| Headless core primitives | Partial | Controllers exist for key primitives; part prop uses `handlers` not `on`. |
| React adapter | Partial | Real components exist (legacy set); SFN-15 conformance bypasses them. |
| Svelte adapter | Partial | Real actions/components exist; conformance bypasses them. |
| Vue adapter | Partial | Composables exist; conformance bypasses real Vue behavior. |
| Solid adapter | Fail | Single primitive (Switch); conformance minimal. |
| Angular adapter | Partial | Package exists; conformance uses minimal fixture, checks static. |
| Styling tokens and themes | Partial | OKLCH helpers and theme files exist; status colors/brand/contrast incomplete. |
| Tailwind integration | Partial | Package exists; full recipe coverage unproven. |
| Recipes | Partial | Package exists; not used to render the full catalog. |
| All 45 components | Fail | 45 manifests, descriptor-level, planned/placeholder. |
| Hooks | Partial | Two hooks present; SSR/browser evidence shallow. |
| Registry CLI | Fail | Source install, lock filename, diff/update states, placeholder validation insufficient. |
| Storybook | Fail | JSON-level metadata, not an executable rendered story matrix. |
| Patterns | Partial | Controlled pattern metadata exists; UI/state depth unproven. |
| Superfunction-backed patterns | Partial | 7 of 14 backed variants. |
| Release gate | Fail | Passes planned placeholders and static checks. |
| Security and provenance | Partial | Scans exist; provenance asserted via metadata. |

## Requirement Coverage Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| ARCH-001 package graph/workspace | Pass with caveats | 16 packages exist, package-graph verifier passes; presence != behavior. |
| ARCH-002 clean-room | Partial | `sourcePolicy: "clean-room"` in manifests; no deep provenance proof. |
| CORE-001 controller factory | Partial | Controllers for key primitives; full inventory unproven. |
| CORE-002 part prop model | Fail | Public field `handlers`, spec `on`. |
| ADAPT-001 shared conformance | Fail | Real adapters bypassed by `createMinimalFixtureAdapter`. |
| ADAPT-002 React | Partial/Fail | APIs exist; conformance/release verification shallow. |
| ADAPT-003 Svelte | Partial/Fail | APIs exist; conformance/release verification shallow. |
| ADAPT-004 Vue | Partial/Fail | APIs exist; conformance shallow. |
| ADAPT-005 Solid | Fail | One primitive; narrow/shallow conformance. |
| ADAPT-006 Angular | Partial/Fail | Package exists; conformance minimal fixture. |
| STYLE-001 token package | Partial | Schema/helpers exist; semantic coverage incomplete. |
| STYLE-002 theme package | Partial | Four theme files; status colors missing. |
| STYLE-003 OKLCH/contrast | Partial | Helpers exist; contrast limited to hard-coded pairs. |
| STYLE-004 semantic surfaces/depth | Pass | Public names semantic; surface/depth supported in recipes. |
| STYLE-005 brand theme generation | Fail | No `createBrandTheme`. |
| STYLE-006 Tailwind/recipes | Partial | Packages exist; full component integration unproven. |
| COMP-001 45-component catalog | Fail | 45 manifests, descriptors, planned/placeholder. |
| COMP-002 styled component contract | Fail | Descriptor factories not renderable APIs. |
| COMP-003 data-rich behavior | Fail | No component-level keyboard/a11y/virtualization. |
| HOOK-001 hooks | Partial | Manifests/verifier pass; SSR/browser evidence shallow. |
| REG-001 manifests | Fail | Placeholder statuses accepted; files unverified. |
| REG-002 source install/diff/update | Fail | Wrapper writes, lock filename mismatch, insufficient diff/update states. |
| STORY-001 Storybook package | Partial | Metadata exists; rendered matrix unproven. |
| STORY-002 a11y/visual/interaction | Fail | JSON metadata, not rendered DOM/visual. |
| PAT-001 controlled patterns | Partial | 14 manifests/models; state/story depth unproven. |
| SF-001 injected clients | Partial | 7 variants use injected-client checks; state coverage incomplete. |
| SF-002 backed variants | Partial | 7 enforced; subspec requires 14. |
| TEST-001 release gate | Fail | Passes planned placeholders and static checks. |
| TEST-002 a11y/visual gates | Fail | Metadata-level. |
| DOCS-001 docs/artifacts | Partial | Docs/reports exist; placeholders and path literals remain. |
| SEC-001 secret/path hygiene | Partial | Scans exist; phase-report path literals and shallow provenance remain. |
| VER-001 versioning/exports | Partial | Metadata exists; GA status not supported by behavioral completeness. |

## Positive Findings

- The 16-package target architecture is present and the package graph verifier reports no cycles or upward-layer imports.
- Real, tested React and Svelte component implementations exist for the legacy GA family set.
- Core controllers and data-rich controllers use deterministic, in-memory state transitions, a usable foundation.
- Theme files use W3C-style token JSON with OKLCH values; OKLCH ramp/contrast helpers exist in tokens.
- Registry, story, fixture, and release metadata share a coherent shape that can be hardened into real gates.
- SF-backed variants use injected-client style checks for the implemented set.

## Recommended Remediation Order

1. Make release gates honest: fail on `planned`/`placeholder` in GA paths, verify referenced files exist, and execute real browser/SSR/render behavior for a11y/visual/story/adapter checks.
2. Replace minimal-fixture conformance with per-framework harnesses that render/instantiate the public API, expanded beyond dialog/checkbox.
3. Implement renderable styled components for the 45-catalog (or mark `@uifn/components` pre-GA and gate only implemented entries), unifying with the existing real React/Svelte components.
4. Align core `UIFnPartProps` to `on` (or amend the spec) and propagate through adapters.
5. Reconcile the 7-vs-14 SF-backed variant conflict and implement the authoritative set; broaden Solid (and verify Vue/Angular) to the full primitive set.
6. Finish the styling contract: `createBrandTheme`, status color groups, computed contrast tokens, and full contrast-pair validation.
7. Align registry lock/selection filenames with the spec, generate real source artifacts with provenance/checksums, and make `diff`/`update` conflict-safe.

## Final Assessment

SFN-15 is not production complete in the audited tree. The implementation is a useful, broad scaffold with some package-level invariants in place, but the current `verify:uifn-release` success is dominated by metadata, placeholders, and static checks. The project should not treat the current gate result as GA evidence until the release gate is made behaviorally strict and the component, adapter, registry, styling, and Superfunction layers are implemented beyond descriptors.
