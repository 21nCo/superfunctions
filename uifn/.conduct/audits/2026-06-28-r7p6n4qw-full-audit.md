# SFN-15 uifn Full Audit

## Metadata

- Timestamp: 2026-06-28T09:25:03Z
- agent_name: unknown-agent
- Model: GPT-5 Codex
- Launcher: Codex Desktop
- Workspace/project path: repo root/uifn
- OS + shell: Darwin arm64, shell zsh
- Git: branch `SFN-15`, commit `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Dirty status at audit time: dirty before this audit artifact was written; many SFN-15 implementation/spec/audit files were already modified or untracked.
- Audit posture: read-only implementation audit. Only this report and the append-only audit log row were written.

## Audit scope

Audited the current `uifn` implementation against the SFN-15 user intent and spec bundle under `uifn/.conduct/SFN-15`.

Implementation scope included:

- `uifn/core`, `uifn/adapter-kit`, `uifn/react`, `uifn/svelte`, `uifn/vue`, `uifn/solid`, `uifn/angular`
- `uifn/tokens`, `uifn/theme`, `uifn/theme-tailwind`, `uifn/recipes`
- `uifn/components`, `uifn/patterns`, `uifn/sf`, `uifn/registry`, `uifn/storybook`
- `uifn/examples`, package manifests, registry manifests, stories, docs, and `scripts/verify-uifn-*.mjs`

Excluded generated/dependency/cache output:

- `node_modules`
- `dist`
- `.vite*`
- `.svelte-kit`

Coverage evidence:

- Initial scoped inventory: 1,018 files across uifn and verification scripts, excluding generated output.
- uifn-specific source/spec/docs scan: 990 files, 176,770 lines, 4,513,139 bytes.
- Final broad `uifn` file count: 1,163 files, including spec and audit artifacts.
- SFN-15 spec bundle file count: 100 files.
- Pattern scan found no implementation `planned` status, descriptor factories, minimal adapter fixtures, or absolute local paths in the uifn-specific scope. One secret-like hit was an intentional forbidden-read string list in `scripts/verify-uifn-sf.mjs`, not a leaked credential.

## Inputs audited (intent + spec bundles)

Authoritative intent inputs:

- User request in thread: make `uifn` production-ready against SFN-15, clean-room, all Coss UI base components and hooks, React/Svelte/Vue/Solid/Angular, package import plus source install, split styling packages, Storybook/workshop testing, Superfunction-backed patterns, breaking changes allowed, no product-specific public naming.
- Repository instructions in the thread: function artifacts under `uifn/.conduct`, npm/Turbo workspace conventions, no nested monorepos, shared code belongs in shared packages.
- Memory orientation only: prior SFN-15 package graph and release-gate context were treated as stale unless revalidated live.

Spec bundle audited: `uifn/.conduct/SFN-15`

Core files:

- `README.md`
- `SPEC.md`
- `REQUIREMENTS.md`
- `TEST_VECTORS.md`
- `PLAN.md`
- `INTENT_AUDIT.md`
- `release-check.schema.json`
- `release-evidence.schema.json`

Subspecs:

- `subspecs/ARCHITECTURE_AND_PACKAGING.md`
- `subspecs/COMPONENT_CATALOG.md`
- `subspecs/FRAMEWORK_ADAPTERS.md`
- `subspecs/PATTERNS_AND_SUPERFUNCTIONS.md`
- `subspecs/REGISTRY_AND_CLI.md`
- `subspecs/STORYBOOK_TESTING_RELEASE.md`
- `subspecs/STYLING_SYSTEM.md`

Data snapshots:

- `data/coss-catalog-snapshot.json`
- `data/current-package-inventory.json`
- `data/delete-or-rewrite-inventory.json`

Execution artifacts audited as evidence, not as compliance authority:

- `phases/PHASE_00.md` through `phases/PHASE_19.md`
- `phase-reports/PHASE_00_BASELINE.md`
- `phase-reports/PHASE_00-2026-06-27-p0b7x2-report.md` through `phase-reports/PHASE_19-2026-06-27-w9k2md-report.md`
- `phase-reports/CLEAN_ROOM_POLICY.md`
- all files under `fix-logs/`
- `uifn/.conduct/SFN-15/logs.csv`

## High-level findings

1. PASS overall, with important partials: the implementation is no longer a placeholder shell. The current full release gate passed 83/83 checks, all five framework adapters execute real framework conformance harnesses, registry/catalog/docs/provenance/security gates pass, and the catalog now covers 45 components plus 2 hooks.

2. PARTIAL/P1: the adapter layer still does not satisfy the plain-language "all primitives" adapter requirement if "all primitives" means the full core primitive controller inventory. Core tests cover 25 controllers, but `@uifn/adapter-kit` conformance imports and vectors cover only dialog, checkbox, popover, select, tabs, and tooltip. The adapter verifier also requires only those six primitive API families per framework. This affects ADAPT-001 through ADAPT-006.

3. PARTIAL/P2: the release gate does not execute or inspect actual package tarball output, even though the spec requires pack output validation and architecture completion requires every public package to pack without leaking tests, fixtures, or private internals. The current static gate checks package scripts, exports, and `files` entries, but no `npm pack --dry-run` or packlist inspection is present.

4. PARTIAL/P2: styled component renderables exist across all five frameworks, but the shared batch-B semantic renderer remains generic for many primitive-backed components. It toggles open/checked/value state and emits generic roles; it does not compose the matching core controllers for every primitive-backed styled component. The browser/a11y/visual gates are strong, but this is not yet the same as full component-specific behavior semantics for every primitive-backed catalog item.

5. PASS: styling, token, Tailwind, recipe, registry, product patterns, Superfunction-backed panels, docs, source-install, clean-room provenance, secret redaction, and release-output honesty are materially improved and currently verified by live commands.

## Intent Inventory (numbered)

1. Create and use the SFN-15 spec bundle for uifn.
2. Make uifn production-ready, not a demo.
3. Support React, Svelte, Vue, Solid, and Angular.
4. Cover all Coss UI base components.
5. Cover Coss hook equivalents.
6. Use Coss as a capability reference only.
7. Keep implementation clean-room with no copied source, prose, examples, comments, or assets.
8. Support package imports and source install.
9. Deliver the target public package graph.
10. Support design tokens and Tailwind.
11. Split styling into tokens, theme, theme-tailwind, and recipes packages.
12. Use semantic public token names.
13. Use W3C Design Tokens-style token shape.
14. Use OKLCH color/ramp generation.
15. Provide light, dark, high-contrast light, and high-contrast dark themes.
16. Provide brand/custom theme generation.
17. Support semantic surfaces and numeric `surfaceDepth`.
18. Support explicit hover/active recipe behavior.
19. Generate Tailwind output from token and recipe contracts.
20. Avoid dynamic Tailwind class generation.
21. Validate contrast automatically.
22. Provide styled components and unstyled/headless escape hatches.
23. Make recipes output class names, CSS variables, inline style objects, and data attributes.
24. Provide Storybook as workshop/test/docs surface.
25. Use Bit concepts only as inspiration, not dependency or implementation requirement.
26. Manifests must include ownership, status, dependencies, tests, stories, framework support, and source policy.
27. Source install must include source files, stories, fixtures, tests, manifests, and lock behavior.
28. Registry must detect local drift and update availability.
29. Provide controlled product patterns.
30. Provide Superfunction-backed pattern variants.
31. Cover authfn, plugfn, filefn, and billfn patterns.
32. Superfunction-backed variants must use injected clients and no app-global clients/secrets.
33. Breaking changes are allowed.
34. Avoid backward-compatibility padding and legacy scaffolding.
35. Avoid product-specific public package names or themes.
36. Provide uniform behavior, accessibility, anatomy parts, data attributes, and framework-native ergonomics.
37. Provide production release gates.
38. Avoid absolute local paths and machine-specific artifacts.

## Intent -> Spec coverage matrix (complete; no sampling)

| Intent | Spec mapping | Spec coverage | Implementation status |
| --- | --- | --- | --- |
| 1 | `README.md`, `SPEC.md`, `PLAN.md`, phases | PASS | PASS |
| 2 | `SPEC.md`, TEST-001, release subspec | PASS | PARTIAL: gate passes, but pack output gap remains |
| 3 | ADAPT-002..006, framework subspec | PASS | PARTIAL: all frameworks exist; "all primitives" adapter breadth is incomplete |
| 4 | COMP-001, catalog snapshot | PASS | PASS: 45 components verified |
| 5 | HOOK-001, catalog snapshot | PASS | PASS: 2 hooks across 5 frameworks verified |
| 6 | ARCH-002, clean-room policy | PASS | PASS |
| 7 | ARCH-002, provenance checks | PASS | PASS |
| 8 | REG-002, registry CLI subspec | PASS | PASS |
| 9 | ARCH-001, package graph | PASS | PASS except pack-output subcriterion |
| 10 | STYLE-001..006 | PASS | PASS |
| 11 | ARCH-001, STYLE-001..006 | PASS | PASS |
| 12 | STYLE-001 | PASS | PASS |
| 13 | STYLE-001 | PASS | PASS |
| 14 | STYLE-003 | PASS | PASS |
| 15 | STYLE-002 | PASS | PASS |
| 16 | STYLE-003 | PASS | PASS |
| 17 | STYLE-004 | PASS | PASS |
| 18 | STYLE-006 | PASS | PASS |
| 19 | STYLE-005 | PASS | PASS |
| 20 | STYLE-005 | PASS | PASS |
| 21 | STYLE-003, TEST-002 | PASS | PASS |
| 22 | COMP-002, ADAPT-002..006 | PASS | PARTIAL: styled and unstyled exist; adapter/core composition not complete for every primitive |
| 23 | STYLE-006 | PASS | PASS |
| 24 | STORY-001..002 | PASS | PASS |
| 25 | Storybook subspec wording | PASS | PASS |
| 26 | REG-001, catalog/registry manifests | PASS | PASS |
| 27 | REG-002 | PASS | PASS |
| 28 | REG-002, registry CLI subspec | PASS | PASS |
| 29 | PAT-001 | PASS | PASS |
| 30 | SF-001 | PASS | PASS |
| 31 | SF-002 | PASS | PASS |
| 32 | SF-001, SEC-001 | PASS | PASS |
| 33 | VER-001 | PASS | PASS |
| 34 | VER-001, package architecture | PASS | PASS |
| 35 | ARCH-002, versioning docs | PASS | PASS |
| 36 | CORE-001..002, ADAPT-001..006, COMP-002 | PASS | PARTIAL: core is broad, adapter/styled semantic breadth is narrower |
| 37 | TEST-001..002 | PASS | PARTIAL: live gate passes; pack-output check missing |
| 38 | SEC-001, release subspec | PASS | PASS in uifn-specific artifacts scanned |

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)

Spec bundle: `uifn/.conduct/SFN-15/REQUIREMENTS.md`

| Status | Count |
| --- | ---: |
| PASS | 23 |
| PARTIAL | 9 |
| FAIL | 0 |
| UNVERIFIED | 0 |

Partials:

- ARCH-001: package graph passes, but pack-output subcriterion is not actually executed.
- ADAPT-001..006: framework adapters are real, but the conformance/API scope is six primitives rather than the full core primitive inventory.
- COMP-002: styled components are real and covered, but many primitive-backed batch-B semantics remain generic instead of using matching core controllers.
- TEST-001: full gate passes, but pack-output validation is absent.

## Requirement-by-requirement results (tables + per-requirement notes)

| ID | Status | Evidence and notes |
| --- | --- | --- |
| ARCH-001 | PARTIAL | `node scripts/verify-uifn-package-graph.mjs` passed for 16 public packages with no cycles or upward layer imports. However architecture completion requires pack-output hygiene, and that check is absent from the gate. |
| ARCH-002 | PASS | Manifests and provenance verifier enforce clean-room `sourcePolicy`; scan found no copied-source indicators in the audited uifn scope. |
| CORE-001 | PASS | `uifn/core/src/__tests__/controller-contract.test.ts:11` through `:36` imports 25 core controllers, and the release gate passes core behavior tests. |
| CORE-002 | PASS | Core part contract tests verify canonical part props, protected accessibility props, deterministic ids, and `on` event metadata. |
| ADAPT-001 | PARTIAL | `uifn/adapter-kit/src/conformance.ts:1` through `:11` imports six controllers, and `ADAPTER_KIT_PRIMITIVE_VECTORS` begins at `:86`; the harness is real but not broad enough for every core primitive. |
| ADAPT-002 | PARTIAL | React has real hooks, compound components, SSR/hydration tests, and asChild coverage for six controller-backed primitives. It also has other local components, but not all primitives expose core-backed hook/component APIs. |
| ADAPT-003 | PARTIAL | Svelte has real components, actions, conformance, context errors, SSR/hydration, and runes-compatible tests. The headless action/core-controller set remains six primitives. |
| ADAPT-004 | PARTIAL | Vue has composables, components, provide/inject, SSR tests, and conformance for six primitives. Not every core primitive has a composable/component API backed by core controllers. |
| ADAPT-005 | PARTIAL | Solid has signal APIs and JSX components for the six conformance primitives plus switch coverage, but the requirement says all primitives and conformance for every primitive. |
| ADAPT-006 | PARTIAL | Angular has standalone directives/components and conformance for the six adapter primitives, but not standalone directive APIs for every core primitive. |
| STYLE-001 | PASS | `@uifn/tokens` validates W3C-style `$type`/`$value`, rejects cryptic names, and exposes semantic public names. Focused token tests passed 8/8. |
| STYLE-002 | PASS | `@uifn/theme` mounts scoped CSS variables, supports four first-party themes, root cleanup, and shadow-root stylesheets. Focused theme tests passed 6/6. |
| STYLE-003 | PASS | OKLCH parsing/conversion, custom surfaces, status colors, and contrast validation are implemented and tested. |
| STYLE-004 | PASS | `@uifn/recipes` supports semantic surfaces and numeric `surfaceDepth`, with invalid depth rejection. |
| STYLE-005 | PASS | `@uifn/theme-tailwind` produces static safelist/classes and CSS-variable colors; focused Tailwind tests passed 2/2. |
| STYLE-006 | PASS | Recipes return `className`, `style`, `vars`, and `data`; tint default and stripe option are tested. Focused recipe tests passed 7/7. |
| COMP-001 | PASS | `node scripts/verify-uifn-components.mjs` passed with 45 components across React/Svelte/Vue/Solid/Angular. |
| COMP-002 | PARTIAL | Styled components render across frameworks and stories/tests exist. But `uifn/components/src/shared/interactive.ts:25` returns no component-specific content role, and `uifn/components/src/react/rendering.ts:154` through `:190` maps anatomy parts through one generic semantic renderer. |
| COMP-003 | PASS | Data-rich controllers cover Data Table, Calendar, Date Picker, Command, Sidebar, and Resizable. A11y/visual gates passed on data-rich scope. |
| HOOK-001 | PASS | `node scripts/verify-uifn-hooks.mjs` passed for `useMediaQuery` and `useCopyToClipboard` equivalents across all five frameworks with SSR-safe behavior. |
| REG-001 | PASS | Registry schemas/manifests validate implementation status, framework refs, sha256/provenance refs, package imports, source policy, and lock metadata. |
| REG-002 | PASS | Registry CLI list/info/add/diff/update/validate checks passed, including `.uifn/registry.lock`, `.uifn/selected-components.json`, source install templates, and drift states. |
| STORY-001 | PASS | `@uifn/storybook` docs/workshop package exists with decorators, compatibility panel metadata, generated docs, mock clients, and framework coverage. |
| STORY-002 | PASS | Story runner, generated-story runner, pattern story runner, SF story runner, a11y, and visual checks passed. |
| PAT-001 | PASS | 14 controlled product patterns exist with 9 required states and no backend imports. |
| SF-001 | PASS | 14 Superfunction-backed variants use injected typed clients, controlled counterparts, fake/mockable clients, and no forbidden global reads. |
| SF-002 | PASS | authfn, plugfn, filefn, and billfn panels are all covered in `@uifn/sf` and its story/test runners. |
| TEST-001 | PARTIAL | Full release gate passed 83/83 and dry-run honestly fails planned checks, but pack-output validation required by the spec is missing. |
| TEST-002 | PASS | Browser a11y and visual gates passed, including Chromium axe/keyboard checks and pixel-diff visual checks for the scoped components/themes/viewports. |
| DOCS-001 | PASS | Docs verifier passed with 19 docs files, 75 pages, 45 components, 2 hooks, 14 patterns, 14 SF variants, and all frameworks. |
| SEC-001 | PASS | Secret/privacy verifier passed. SF/client code uses injected clients, fake credentials, redaction of token/local-path/email-like values, and no app-global client reads. |
| VER-001 | PASS | Versioning docs, status metadata, pre-SFN-15 surface cleanup, and package graph validation are present; breaking-change posture is consistent. |

## Spec conflicts / spec gaps (explicit)

1. Adapter primitive scope ambiguity: `REQUIREMENTS.md` says every primitive for React/Svelte/Vue/Solid/Angular, and Solid explicitly says conformance for every primitive. `FRAMEWORK_ADAPTERS.md` shows examples, and `TEST_VECTORS.md` gives only selected primitive examples. The implementation chose six conformance primitives. This should be resolved by either narrowing the spec's "all primitives" language or expanding adapters/gates to the 25 core controller inventory.

2. Pack-output validation is specified but underspecified in the gate implementation. `STORYBOOK_TESTING_RELEASE.md:61` through `:84` requires pack output validation, and `ARCHITECTURE_AND_PACKAGING.md:83` through `:89` says every public package must pack without tests, fixtures, or private internals leaking. `scripts/verify-uifn-release.mjs:181` through `:193` only checks `prepack`, exports, and `files`, while verifier checks at `:214` through `:229` do not add a pack command.

3. Styled components versus primitive semantics: the component catalog marks many components primitive-backed, while the shared styled renderer uses generic open/checked/value semantics for broad batches. The spec should clarify whether styled components must compose `@uifn/core` controllers for every primitive-backed catalog item or whether visual/anatomy/state parity is sufficient.

## Cross-cutting audits (security/determinism/limits/errors/compat)

Security/authz/validation boundaries:

- PASS. SF-backed components accept injected clients; no app-global client reads were found.
- PASS. Secret verifier passed and redaction covers token-like keys, local paths, and email-like values.
- PASS. Registry validation rejects non-release statuses and enforces provenance/checksum/file existence.

Determinism invariants:

- PASS. Core controller tests use deterministic environment hooks.
- PASS. Registry lockfile and selected-components files are deterministic artifacts.
- PASS. Release gate emits structured JSON with `schemaVersion`, mode, checks, summary, coverage, and sanitized failure details.

Limits/caps:

- PASS. Surface depth caps are enforced.
- PASS. Data-rich components expose deterministic sorting/filtering/pagination/selection/virtualization behavior.
- PASS. Tailwind class generation rejects unsafe dynamic fragments.

Error handling + canonical envelopes:

- PASS. Core and adapter errors use explicit `UIFN_*` codes.
- PASS. Release dry-run returns planned-check failures instead of false success.
- PASS. Registry/source-install diagnostics use structured failures.

Compatibility/versioning/migrations:

- PASS. The implementation follows the user-approved breaking-change posture.
- PASS. Public package metadata uses `ga-candidate`/`beta` status and clean-room source policy.
- PARTIAL. Pack-output validation should be added before treating release artifacts as complete.

## Recommendations (ranked)

1. Expand adapter APIs and conformance to the full core primitive inventory, or explicitly narrow the spec. A true fix should update `ADAPTER_KIT_PRIMITIVE_VECTORS`, each framework's headless/component APIs, adapter verifier required sources, and release-gate coverage. Applies to intent 3, 22, 36 and ADAPT-001..006.

2. Add real package pack-output verification. Run `npm pack --dry-run --json` or a packlist equivalent for every public package, inspect included files, and fail on tests, fixtures, private internals, local paths, generated cache output, or missing runtime assets. Applies to intent 2, 9, 37 and ARCH-001/TEST-001.

3. Decide and enforce the styled primitive-backed component contract. If primitive-backed styled components must use core controllers, wire them through `@uifn/core` or framework adapters and add tests that prove component-specific roles, keyboard behavior, focus/portal behavior, and data attributes for each primitive-backed catalog entry. Applies to intent 22, 36 and COMP-002.

4. Keep the current release-gate honesty behavior. The dry-run planned-failure behavior and secret/local-path redaction are good safeguards and should not be loosened to make green output easier.

## Appendix: commands run + environment details

Commands are shown in repository-relative form. Node/npm were run from the local development environment.

Spec and inventory:

- `rg --files uifn/.conduct/SFN-15 | sort`
- `find uifn ... -type f ... | wc -l`
- source scan script over the audited uifn scope, excluding generated/dependency/cache folders
- `rg -n "TODO|FIXME|defer|placeholder|planned|descriptorFactory|minimalFixtureAdapter|absolute local|localStorage.authToken|process.env.AUTHFN_TOKEN|globalThis.authfn" uifn scripts/verify-uifn-*.mjs package.json release-packages.json`

Primary verification:

- `node scripts/verify-uifn-components.mjs`
- `node scripts/verify-uifn-release.mjs --dry-run`
- `node scripts/verify-uifn-release.mjs`
- `node scripts/verify-uifn-adapter.mjs --framework react`
- `node scripts/verify-uifn-adapter.mjs --framework svelte`
- `node scripts/verify-uifn-adapter.mjs --framework vue`
- `node scripts/verify-uifn-adapter.mjs --framework solid`
- `node scripts/verify-uifn-adapter.mjs --framework angular`
- `node scripts/verify-uifn-catalog.mjs`
- `node scripts/verify-uifn-registry.mjs`
- `node scripts/verify-uifn-docs.mjs`
- `node scripts/verify-uifn-secrets.mjs`
- `node scripts/verify-uifn-provenance.mjs`
- `node scripts/verify-uifn-a11y.mjs --scope batch-b`
- `node scripts/verify-uifn-visual.mjs --scope data-rich`
- `node scripts/verify-uifn-stories.mjs`
- `node scripts/verify-uifn-package-graph.mjs`

Focused package tests:

- `npm --workspace @uifn/tokens run test`
- `npm --workspace @uifn/theme run test`
- `npm --workspace @uifn/recipes run test`
- `npm --workspace @uifn/theme-tailwind run test`

Static evidence inspection:

- `rg -n "ADAPTER_KIT_PRIMITIVE_VECTORS|createReactHookFixtureAdapter|createSvelteActionFixtureAdapter|createVueComposableFixtureAdapter|createSolidSignalFixtureAdapter|createAngularDirectiveFixtureAdapter|createCoreFixtureAdapter" ...`
- `rg -n "npm pack|pack --dry-run|packlist|tarball|files" scripts/verify-uifn-release.mjs scripts/verify-uifn-package-graph.mjs package.json uifn/*/package.json release-packages.json`
- `nl -ba uifn/adapter-kit/src/conformance.ts`
- `nl -ba uifn/core/src/__tests__/controller-contract.test.ts`
- `nl -ba scripts/verify-uifn-release.mjs`
- `nl -ba uifn/components/src/shared/interactive.ts`
- `nl -ba uifn/components/src/react/rendering.ts`

Environment/metadata:

- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse HEAD`
- `git status --short`
- `date -u +%Y-%m-%dT%H:%M:%SZ`
- `uname -sm`
