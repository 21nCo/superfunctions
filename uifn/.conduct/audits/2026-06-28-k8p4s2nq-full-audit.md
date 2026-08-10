# SFN-15 uifn Full Audit

## Metadata

- Audit timestamp: 2026-06-28T02:48:51Z
- Audit id: 2026-06-28-k8p4s2nq
- Agent name: unknown-agent
- Model: GPT-5 Codex
- Launcher: Codex Desktop
- Workspace: repo root, project scope `uifn`
- Shell/OS: zsh on Darwin
- Git branch: `SFN-15`
- Git upstream display: `sf-next/next`
- Git commit audited: `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Git status at audit time: dirty before this report was written, with SFN-15 implementation files already modified/untracked across root scripts, package metadata, `uifn/.conduct/SFN-15`, and the new `uifn/*` packages.

## Scope

User request: perform a thorough audit of the current `uifn` implementation against the `.conduct/SFN-15` spec.

Intent and spec sources audited:

- `uifn/.conduct/SFN-15/README.md`
- `uifn/.conduct/SFN-15/INTENT_AUDIT.md`
- `uifn/.conduct/SFN-15/SPEC.md`
- `uifn/.conduct/SFN-15/REQUIREMENTS.md`
- `uifn/.conduct/SFN-15/TEST_VECTORS.md`
- `uifn/.conduct/SFN-15/PLAN.md`
- `uifn/.conduct/SFN-15/subspecs/*.md`
- `uifn/.conduct/SFN-15/phases/*.md`
- `uifn/.conduct/SFN-15/phase-reports/*.md`

Implementation sources audited:

- `uifn/**`
- `scripts/verify-uifn-*.mjs`
- root `package.json` and `package-lock.json` where they define workspaces and release scripts

Generated/build output, package manager caches, and dependency folders were not treated as source of truth except where release evidence referred to generated artifacts.

## Commands Run

- `git status --short --branch`
- `git rev-parse HEAD`
- `node scripts/verify-uifn-package-graph.mjs`
- `node scripts/verify-uifn-catalog.mjs`
- `node scripts/verify-uifn-registry.mjs`
- `node scripts/verify-uifn-hooks.mjs`
- `npm run verify:uifn-release -- --dry-run`
- `npm run verify:uifn-release`
- targeted `rg`, `nl`, and JSON inspection commands over `uifn/.conduct/SFN-15`, `uifn/**`, and `scripts/verify-uifn-*.mjs`

The full release gate reported success in the current tree. This audit does not accept that as sufficient because several release checks are static metadata checks that pass planned placeholders and descriptor-only implementations.

## Executive Summary

The implementation establishes a broad SFN-15 skeleton: all 16 target packages exist, the package graph verifier passes, public package names mostly align with the spec, first-party theme files exist, 45 component manifests and 2 hook manifests exist, 14 controlled pattern manifests exist, and a release gate currently returns `ok: true`.

The implementation is not SFN-15 complete. The most important gaps are behavioral rather than organizational:

1. Framework adapter conformance is not actually running real React, Svelte, Vue, Solid, or Angular adapters. Every framework conformance entry uses `createMinimalFixtureAdapter(...)`, which drives core controllers directly through a test fixture.
2. `@uifn/components` does not provide renderable styled component implementations for the 45 Coss-compatible components. It mostly exports descriptor factories and metadata.
3. Registry component manifests remain `status: "planned"` with placeholder stories, fixtures, and tests. The registry validators and release gate still accept them.
4. A11y, visual, story, adapter, and registry release checks are shallow enough to produce false confidence.
5. Registry source install writes generated wrapper/metadata files and `.uifn/lock.json`, not the source-installed component files, `.uifn/registry.lock`, and `.uifn/selected-components.json` required by the detailed registry spec.
6. SF-backed pattern coverage enforces only 7 backed variants, while the detailed pattern subspec lists 14.
7. Core part props use `handlers` where the SFN-15 public shape specifies `on`.
8. Theme generation and contrast coverage are partial: no `createBrandTheme` implementation was found, status color groups are absent from first-party theme JSON, and contrast validation checks only three hard-coded pairs.

Overall status: package scaffolding is broad, but the current implementation is closer to a contract scaffold plus metadata-driven acceptance harness than a production-ready SFN-15 implementation.

## Top Findings

### P0 - Adapter conformance bypasses the real framework adapters

SFN-15 requires every adapter to expose a component API, a headless attachment API, and a conformance adapter that runs shared vectors against the actual framework behavior (`uifn/.conduct/SFN-15/SPEC.md:149`, `uifn/.conduct/SFN-15/SPEC.md:155`). It also requires missing framework adapters, including Angular, to fail conformance.

Current framework conformance files all instantiate the adapter-kit's minimal fixture adapter:

- `uifn/react/src/conformance/react-conformance.ts` uses `createMinimalFixtureAdapter('react')`.
- `uifn/svelte/src/conformance/svelte-conformance.ts` uses `createMinimalFixtureAdapter('svelte')`.
- `uifn/vue/src/conformance/vue-conformance.ts` uses `createMinimalFixtureAdapter('vue')`.
- `uifn/solid/src/conformance/solid-conformance.ts` uses `createMinimalFixtureAdapter('solid')`.
- `uifn/angular/src/conformance/angular-conformance.ts` uses `createMinimalFixtureAdapter('angular')`.

The minimal adapter constructs core fixtures directly. `uifn/adapter-kit/src/conformance.ts:224` creates a core fixture, `uifn/adapter-kit/src/conformance.ts:230` calls `createDialogController`, `uifn/adapter-kit/src/conformance.ts:243` calls `createCheckboxController`, and `uifn/adapter-kit/src/conformance.ts:266` exports `createMinimalFixtureAdapter`.

This means the conformance suite can pass even if a framework component/hook/action/composable/directive is broken, because the test path avoids the real adapter. `scripts/verify-uifn-adapter.mjs:24` through `scripts/verify-uifn-adapter.mjs:53` further confirms the release verifier checks required files and string tokens, not rendered or hydrated adapter behavior.

Impact: high. This invalidates the adapter conformance release evidence for ADAPT-001 through ADAPT-006.

Recommended fix: replace the minimal fixture wiring in each framework package with a real adapter fixture that renders or instantiates that framework's public API, then make `verify-uifn-adapter.mjs` execute those conformance suites and fail on behavior drift.

### P0 - `@uifn/components` is descriptor-level, not a styled component library

SFN-15 requires styled packages for all 45 Coss-compatible components, with cross-framework exports, stories, fixtures, tests, source-install metadata, and clean-room behavior (`uifn/.conduct/SFN-15/SPEC.md:235` through `uifn/.conduct/SFN-15/SPEC.md:253`; `uifn/.conduct/SFN-15/subspecs/COMPONENT_CATALOG.md`).

The current `@uifn/components` shared implementation returns descriptors rather than framework-renderable components:

- `uifn/components/src/shared/batch-a.ts:238` defines `renderBatchAComponent(...)`; `uifn/components/src/shared/batch-a.ts:248` returns a descriptor with framework, component, tag/class/data/parts metadata.
- `uifn/components/src/shared/data-rich.ts:278` defines `DataRichDescriptor`; `uifn/components/src/shared/data-rich.ts:284` returns `() => ({ framework, component, source: 'clean-room-controller' })`.
- Framework exports wrap those descriptor factories instead of rendering actual React/Svelte/Vue/Solid/Angular UI.

The data-rich controllers contain some useful deterministic state logic, but the exported component layer is not the production component surface SFN-15 describes. For example, Data Table, Calendar, Date Picker, Command, Sidebar, and Resizable need real keyboard/a11y/render behavior and not just descriptor metadata.

Impact: high. COMP-001, COMP-002, COMP-003, STORY-001, STORY-002, TEST-001, and TEST-002 cannot be considered satisfied by this implementation.

Recommended fix: implement real clean-room component source per framework, or generate framework-specific renderable wrappers from a shared headless contract, then add framework tests that render public APIs rather than descriptor objects.

### P0 - Registry component manifests are planned placeholders, yet validation passes

The current component catalog has the right count but not implementation-ready evidence. A direct scan of `uifn/registry/catalog/components` found:

```json
{
  "files": 45,
  "planned": 45,
  "placeholder": 675,
  "implemented": 0,
  "verified": 0
}
```

`uifn/registry/catalog/components/button.json:7` has `status: "planned"`. Its story, fixture, and test entries are all placeholders, for example `uifn/registry/catalog/components/button.json:103` through `uifn/registry/catalog/components/button.json:180`.

The validator only requires fields and metadata presence. `uifn/registry/src/schema.ts:65` through `uifn/registry/src/schema.ts:70` require basic fields, `uifn/registry/src/schema.ts:84` requires that tests array exists, and `uifn/registry/src/schema.ts:92` through `uifn/registry/src/schema.ts:97` require framework metadata. It does not reject `planned` or `placeholder`, and it does not verify referenced files exist or are executable.

Impact: high. The catalog verifier can report complete coverage while every component manifest remains non-implemented. This is a release-blocking mismatch with REG-001, COMP-001, STORY-001, STORY-002, TEST-001, and DOCS-001.

Recommended fix: make registry validation fail unless implementation status is allowed for the release mode, all referenced files exist, placeholder statuses are absent from GA paths, checksums are present, and tests/stories are executable.

### P0 - Release gate gives false confidence for a11y, visual, stories, adapters, and registry

The release gate reported `ok: true` on the full run and `ok: true` in dry-run mode. Dry-run listed 80 blocking checks with `status: "planned"` and zero pass/fail execution. The full run did execute commands, but several of the commands are shallow:

- `scripts/verify-uifn-adapter.mjs` checks file presence and source tokens instead of running real framework conformance.
- `scripts/verify-uifn-a11y.mjs:21` through `scripts/verify-uifn-a11y.mjs:90` reads JSON fixture/story metadata and checks booleans such as keyboard and focus-visible. It does not run a browser, axe, ARIA assertions, focus traversal, or screen-reader oriented DOM checks.
- `scripts/verify-uifn-visual.mjs:22` through `scripts/verify-uifn-visual.mjs:64` reads story and fixture JSON and checks matrix keys. It does not render visual snapshots or compare pixels.
- Registry checks accept planned/placeholder entries as described above.

Impact: high. This violates the SFN-15 release-gate requirement that build, type, lint, unit, conformance, a11y, interaction, visual, SSR, pack, export-map, manifest, docs, token, Tailwind, and secret checks block false success (`uifn/.conduct/SFN-15/SPEC.md:427` through `uifn/.conduct/SFN-15/SPEC.md:436`).

Recommended fix: split metadata linting from behavioral gates, make placeholder/planned statuses fail production release, and require actual browser/SSR/component/adaptor execution evidence for `verify:uifn-release`.

### P1 - Registry source install is not the source-install system described by SFN-15

The detailed registry spec requires source-installed files and two project metadata files: `.uifn/registry.lock` and `.uifn/selected-components.json` (`uifn/.conduct/SFN-15/subspecs/REGISTRY_AND_CLI.md:78` through `uifn/.conduct/SFN-15/subspecs/REGISTRY_AND_CLI.md:83`). It also requires `uifn diff` to report unchanged, locally modified, registry update available, checksum mismatch, unsupported local edit conflict, and missing file (`uifn/.conduct/SFN-15/subspecs/REGISTRY_AND_CLI.md:87` through `uifn/.conduct/SFN-15/subspecs/REGISTRY_AND_CLI.md:96`).

The implementation writes `.uifn/lock.json` (`uifn/registry/src/lockfile.ts:18` through `uifn/registry/src/lockfile.ts:20`) and has no selected-components file. `uifn/registry/src/add.ts:75` through `uifn/registry/src/add.ts:101` generates thin metadata wrappers, placeholder stories, placeholder fixtures, and tests that only assert the lock key contains the slug. `uifn/registry/src/diff.ts:5` supports only `missing`, `modified`, and `unchanged`; `uifn/registry/src/update.ts:16` through `uifn/registry/src/update.ts:27` calls `addArtifact` again, which overwrites files without first modeling unsupported local edit conflicts.

Impact: medium-high. The CLI can install something, but not the source distribution and drift semantics SFN-15 promises.

Recommended fix: align lock and selection filenames with the spec or update the spec explicitly, generate real source-installed component artifacts, record provenance/checksums, and make update/diff conflict-safe.

### P1 - SF-backed pattern coverage is partial against the detailed subspec

The high-level SFN-15 text names seven backed variants in one acceptance section, and the implementation matches that shorter set. The detailed pattern subspec expands the phase-one backed variants to 14: AuthFn has 4, PlugFn has 3, FileFn has 4, and BillFn has 3 (`uifn/.conduct/SFN-15/subspecs/PATTERNS_AND_SUPERFUNCTIONS.md:70` through `uifn/.conduct/SFN-15/subspecs/PATTERNS_AND_SUPERFUNCTIONS.md:114`).

`scripts/verify-uifn-sf.mjs:10` through `scripts/verify-uifn-sf.mjs:26` enforces only these seven:

- `AuthFnAuthPanel`
- `AuthFnApiKeyTable`
- `PlugFnProviderPicker`
- `PlugFnOAuthConnectionsPanel`
- `FileFnFileDropzonePanel`
- `BillFnBillingPlanCards`
- `BillFnSubscriptionStatusPanel`

Missing relative to the detailed subspec:

- `AuthFnSessionList`
- `AuthFnUserProfileCard`
- `PlugFnWebhookEndpointTable`
- `FileFnUploadProgressList`
- `FileFnFileListPanel`
- `FileFnQuotaUsagePanel`
- `BillFnInvoiceTable`

Impact: medium-high. SF-001 and SF-002 are partially satisfied, but detailed phase-one backed coverage is incomplete.

Recommended fix: reconcile the high-level and detailed spec lists, then implement and gate the authoritative backed-variant set.

### P1 - Core part props use `handlers` instead of the specified `on`

SFN-15 specifies `UIFnPartProps` with `on?: Record<string, UIFnEventHandler>` (`uifn/.conduct/SFN-15/SPEC.md:125` through `uifn/.conduct/SFN-15/SPEC.md:130`). The implementation uses `handlers?: UIFnPartEventHandlers` in `uifn/core/src/parts.ts:20` through `uifn/core/src/parts.ts:27`, and adapter conformance triggers `part.handlers` in `uifn/adapter-kit/src/conformance.ts:235` through `uifn/adapter-kit/src/conformance.ts:250`.

Impact: medium-high. This is public API drift in the core cross-framework part contract. It also leaks into adapter tests and framework prop conversion.

Recommended fix: either rename the public field to `on` and update adapters/tests, or amend SFN-15 before GA. If compatibility is needed, keep `handlers` as an internal alias only.

### P1 - Styling and theming are incomplete versus the detailed token contract

SFN-15 requires public semantic tokens including `color.danger.solid`, `color.warning.solid`, and `color.success.solid` (`uifn/.conduct/SFN-15/subspecs/STYLING_SYSTEM.md:25` through `uifn/.conduct/SFN-15/subspecs/STYLING_SYSTEM.md:37`). It requires a typed `createBrandTheme(...)` generator (`uifn/.conduct/SFN-15/subspecs/STYLING_SYSTEM.md:78` through `uifn/.conduct/SFN-15/subspecs/STYLING_SYSTEM.md:87`) and computed `accent.contrast`, `danger.contrast`, `warning.contrast`, and `success.contrast` per theme (`uifn/.conduct/SFN-15/subspecs/STYLING_SYSTEM.md:89` through `uifn/.conduct/SFN-15/subspecs/STYLING_SYSTEM.md:94`).

The implementation has useful OKLCH helpers in `uifn/tokens/src/oklch.ts`, including `createOklchRamp` at `uifn/tokens/src/oklch.ts:45` and `validateContrastPair` at `uifn/tokens/src/oklch.ts:89`. But no implementation of `createBrandTheme` was found. First-party theme JSON such as `uifn/theme/src/themes/uifn-light.json:7` through `uifn/theme/src/themes/uifn-light.json:35` includes surface, text, border, and accent, but not danger/warning/success groups. `validateThemeContrast` checks only three hard-coded pairs at `uifn/tokens/src/oklch.ts:135` through `uifn/tokens/src/oklch.ts:164`.

Impact: medium-high. STYLE-001 and STYLE-002 are partially satisfied, while STYLE-003 and the color contrast portions of TEST-002 are incomplete.

Recommended fix: implement `createBrandTheme`, generate full semantic color groups, attach metadata for foreground/background relationships, and validate all non-decorative foreground/background token pairs.

### P2 - Artifact portability checks miss existing phase-report path literals

SFN-15 generated artifacts are expected to avoid local machine paths and host/user-specific leakage. Several phase reports include local home-directory path literals inside command text, while later phase reports also claim targeted scans passed. Examples include phase reports for adapter, catalog, component, registry, storybook, release, and SF work.

Impact: medium. This is mostly documentation hygiene, but it undermines SEC-001 and DOCS-001 evidence and makes artifacts less portable.

Recommended fix: sanitize historical phase reports or clearly mark them as non-release evidence, then make release hygiene scans include all `.conduct/SFN-15/phase-reports` files.

## Intent Coverage Matrix

The SFN-15 intent inventory in `INTENT_AUDIT.md` lists 38 intent items. Current implementation coverage against those intents:

| Intent area | Status | Notes |
| --- | --- | --- |
| Production-ready `uifn` package family | Partial | Package family exists, but several packages are descriptor or metadata level. |
| Clean-room Coss-compatible catalog | Partial | 45 public names are cataloged with clean-room metadata, but manifests are planned/placeholders and components are not implemented as real renderables. |
| No path back to legacy Nucleus UI internals | Partial | No direct dependency surfaced in scanned implementation, but release hygiene misses phase-report path literals. |
| Headless core primitives | Partial | Controllers exist for key primitives, but the part prop contract uses `handlers` instead of `on`, and coverage is not clearly complete for every stateful primitive implied by the component catalog. |
| React adapter | Partial | Hooks/components exist for core primitives, but conformance bypasses real React behavior. |
| Svelte adapter | Partial | Actions/components exist for core primitives, but conformance bypasses real Svelte behavior. |
| Vue adapter | Partial | Composables exist for some primitives, but conformance bypasses real Vue behavior. |
| Solid adapter | Partial | Some Solid APIs exist, but conformance is minimal and the adapter surface is narrower than the shared primitive set. |
| Angular adapter | Partial | Angular package exists, but conformance uses the minimal fixture and the release check is static. |
| Styling tokens and themes | Partial | OKLCH helpers and first-party theme files exist; brand generation/status color/contrast contract is incomplete. |
| Tailwind integration | Partial | Package exists, but audit did not find evidence of full cross-component recipe coverage. |
| Recipes | Partial | Recipe package exists, but component implementation is not using it to render the full catalog. |
| All 45 components | Fail | 45 manifests exist, but component implementations are descriptor-level and manifests are planned/placeholders. |
| Hooks | Partial | Two hooks are present and verifier passes, but behavioral SSR/browser evidence is shallow. |
| Registry CLI | Partial/Fail | Basic CLI functions exist, but source install, lock files, diff/update semantics, and placeholder validation do not meet detailed spec. |
| Storybook | Partial/Fail | Story metadata exists, but evidence is JSON-level rather than an executable Storybook component matrix. |
| Patterns | Partial | Controlled pattern metadata/models exist, but full UI and required story/fixture state coverage are not proven. |
| Superfunction-backed patterns | Partial | Injected-client approach is aligned for 7 variants; detailed subspec lists 14. |
| Release gate | Fail | Current gate can pass planned placeholders and shallow checks. |
| Security and provenance | Partial | Clean-room metadata and secret scans exist, but provenance verification and artifact hygiene are incomplete. |

## Requirement Coverage Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| ARCH-001 package graph and workspace structure | Pass with caveats | All 16 target packages exist and `node scripts/verify-uifn-package-graph.mjs` passes. Caveat: package presence does not imply behavioral completeness. |
| ARCH-002 clean-room/public-name capability reference | Partial | Manifests carry `sourcePolicy: "clean-room"`, but no deep source-similarity/provenance audit was found. |
| CORE-001 controller factory shape | Partial | Core controllers and `destroy`/subscribe patterns exist for key primitives, but complete primitive inventory coverage was not proven. |
| CORE-002 part prop model | Partial/Fail | Required prop merge exists, but public event field is `handlers`, not spec `on`. |
| ADAPT-001 shared adapter conformance | Fail | Real adapters are bypassed by `createMinimalFixtureAdapter`. |
| ADAPT-002 React | Partial/Fail | React APIs exist, conformance and release verification are shallow. |
| ADAPT-003 Svelte | Partial/Fail | Svelte APIs exist, conformance and release verification are shallow. |
| ADAPT-004 Vue | Partial/Fail | Vue APIs exist, conformance and release verification are shallow. |
| ADAPT-005 Solid | Partial/Fail | Solid package exists but surface/conformance is narrow and shallow. |
| ADAPT-006 Angular | Partial/Fail | Angular package exists but conformance is minimal fixture based. |
| STYLE-001 token package | Partial | Token schema/helpers exist; semantic coverage incomplete. |
| STYLE-002 theme package | Partial | Four first-party theme files exist; semantic status colors are missing. |
| STYLE-003 OKLCH and contrast | Partial | OKLCH helpers exist; contrast validation is limited to hard-coded pairs. |
| STYLE-004 cryptic aliases not public | Pass | Public theme names observed are semantic. |
| STYLE-005 brand theme generation | Fail | No `createBrandTheme` implementation found. |
| STYLE-006 Tailwind/recipes | Partial | Packages exist; full component recipe integration not proven. |
| COMP-001 45 component catalog | Partial/Fail | 45 manifests exist; all are planned and component exports are descriptors. |
| COMP-002 styled component implementations | Fail | Descriptor factories do not satisfy renderable styled component APIs. |
| COMP-003 data-rich behavior | Partial/Fail | Some controllers exist, but component-level keyboard/a11y/virtualization evidence is missing. |
| HOOK-001 hooks | Partial | Hook manifests and verifier pass, but SSR/browser behavior evidence is shallow. |
| REG-001 registry manifests | Partial/Fail | Manifest count passes; planned/placeholders are accepted. |
| REG-002 registry source install/diff/update | Fail | Generated wrappers, lock filename mismatch, and insufficient diff/update states. |
| STORY-001 Storybook package | Partial | Storybook package and metadata exist; actual rendered story matrix not proven. |
| STORY-002 a11y/visual/interaction stories | Fail | Release checks inspect JSON metadata, not rendered DOM/visual output. |
| PAT-001 controlled patterns | Partial | 14 controlled pattern manifests/models exist; required state/story depth not fully proven. |
| SF-001 injected clients and state surfaces | Partial | Current 7 variants use injected-client checks; full state coverage and detailed set are incomplete. |
| SF-002 backed variants | Partial | Current implementation enforces 7 variants; detailed subspec requires 14. |
| TEST-001 release gate | Fail | Gate reports success while accepting planned placeholders and static checks. |
| TEST-002 behavioral quality gates | Fail | A11y and visual checks are metadata-level. |
| DOCS-001 docs and artifacts | Partial | Docs/phase reports exist, but placeholders and local path literals remain. |
| SEC-001 secret/path hygiene | Partial | Secret scans exist; phase-report path literals and shallow provenance remain. |
| VER-001 versioning/public exports | Partial | Package metadata exists, but GA-candidate status is not supported by behavioral completeness. |

## Cross-Cutting Audit

### Security, Privacy, and Provenance

The codebase makes a visible effort to encode clean-room source policy and scan for secrets. The implementation also avoids obvious direct reads from global superfunction clients in the SF package verifier. However, provenance is mostly asserted through metadata and string scans. There is no evidence of a deep clean-room comparison or source provenance proof for component implementations, and historical phase reports contain local path literals in command text.

### Determinism and State

Core controllers and data-rich controllers use deterministic, in-memory state transitions. This is a useful foundation. The missing piece is adapter/component execution evidence: deterministic core logic is not enough to prove framework-level DOM, keyboard, focus, hydration, or source-install behavior.

### Limits, Caps, and Large Data

Data-rich fixtures include large-data metadata, and visual checks look for a Data Table row count fixture. But the visual verifier does not render the table, measure performance, or validate virtualization behavior. Large-data acceptance is therefore metadata-level.

### Error Shapes and Diagnostics

The implementation uses structured error codes across core, registry, and verification scripts. This aligns with SFN-15 intent. Gaps remain in diagnostic precision: placeholder manifests pass validation, registry diff does not expose all required states, and update does not model local edit conflicts before writing.

### Compatibility and Public API

SFN-15 allows breaking old `uifn` APIs. The public part-props drift from `on` to `handlers` should be resolved before GA because it affects every adapter and source-installed consumer. Package status should not imply GA readiness until behavioral gates replace metadata gates.

## Positive Findings

- The 16-package target architecture is present.
- Package graph verification passes with no reported cycles or upward imports.
- First-party framework packages exist for React, Svelte, Vue, Solid, and Angular.
- Clean-room source policy appears in registry manifests.
- Core controllers include structured state/action/part concepts for key primitives.
- Theme files use W3C-style token JSON and OKLCH values.
- Registry, story, fixture, and release metadata have a coherent shape that can be hardened into real gates.
- Superfunction-backed variants use injected-client style checks for the currently implemented set.

## Recommended Remediation Order

1. Make release gates honest. Planned/placeholder statuses must fail production release, and a11y/visual/story/adapter checks must execute behavior, not just inspect JSON or source tokens.
2. Replace minimal fixture adapter conformance with real per-framework conformance harnesses.
3. Implement renderable styled components for all 45 catalog entries, or mark the package pre-GA and gate only implemented entries.
4. Harden registry validation and source install: real source files, provenance, checksums, `.uifn/registry.lock`, `.uifn/selected-components.json`, and conflict-aware diff/update.
5. Resolve the 7-vs-14 SF-backed variant spec conflict and implement the authoritative set.
6. Align `UIFnPartProps` with the spec's `on` event field or formally update the spec before GA.
7. Finish the styling contract: `createBrandTheme`, status color groups, computed contrast tokens, and full contrast-pair validation.
8. Clean or quarantine phase-report artifacts that include local path literals.

## Final Assessment

SFN-15 is not production complete in the audited tree. The implementation is a useful and broad scaffold, and several package-level invariants are in place, but the current success signal is dominated by metadata, placeholders, and static token checks. The project should not treat the current `verify:uifn-release` success as GA evidence until the release gate is made behaviorally strict and the component/adapter/registry layers are implemented beyond descriptors.
