# Metadata

- Timestamp: `2026-03-25T06:08:18Z`
- Agent name: `audit`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/uifn`
- OS + shell: `Darwin ArBook.local 25.3.0 arm64`, shell `/bin/zsh`
- Repo metadata: git repo detected at `/Users/serro/Documents/dev/n/superfunctions`; branch `next`; commit `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`; dirty worktree `yes`
- Intent/notes paths audited:
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/SPEC.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/react/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/files/README.md`
  - User request in thread: perform a production-readiness audit for `uifn`, with React and Svelte explicitly required to be fully production-ready
- Spec bundle paths audited:
  - Bundle root: `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec`
  - Included files:
    - `INTENT_AUDIT.md`
    - `PLAN.md`
    - `REQUIREMENTS.md`
    - `SPEC.md`
    - `TEST_VECTORS.md`
    - `release-evidence/PHASE_07-accessibility-checklist-template.md`
    - `release-evidence/PHASE_07-accessibility-evidence-2026-03-20.md`
    - `release-evidence/PHASE_07-automated-a11y-smoke-2026-03-20.md`
    - `release-evidence/PHASE_07-coverage-by-family-2026-03-20.md`
- Codebase scope audited:
  - Root: `/Users/serro/Documents/dev/n/superfunctions/uifn`
  - Implementation focus: `uifn/core`, `uifn/react`, `uifn/svelte`
  - Documentation/support-matrix focus: `uifn/README.md`, `uifn/SPEC.md`, `uifn/vue`, `uifn/files`
  - Excluded from pass/fail except historical context: prior audit artifacts under `uifn/.conduct/audits`
- Commands executed during audit: see `Appendix: commands run + environment details`

# Audit scope

This was a full, read-only production-readiness audit of `uifn` against:

1. the user’s explicit intent that `uifn` be fully production-ready for both React and Svelte, and
2. the existing `uifn` intent/docs plus the full audit-fix spec bundle created on `2026-03-20`.

The implementation audit covered the shared `@uifn/core` layer because React and Svelte both depend on it, and it also covered the root/package documentation needed to validate support-matrix truthfulness. No implementation files were modified.

# Inputs audited (intent + spec bundles)

## Intent / notes / docs

- `uifn/README.md`
- `uifn/SPEC.md`
- `uifn/core/README.md`
- `uifn/react/README.md`
- `uifn/svelte/README.md`
- `uifn/vue/README.md`
- `uifn/files/README.md`
- User request: production-readiness audit for `uifn`, with React and Svelte treated as explicit release-blocking scope

## Spec bundle

- Bundle root: `uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec`
- Included normative files:
  - `INTENT_AUDIT.md`
  - `PLAN.md`
  - `REQUIREMENTS.md`
  - `SPEC.md`
  - `TEST_VECTORS.md`
- Included release-evidence files reviewed as implementation evidence:
  - `release-evidence/PHASE_07-accessibility-checklist-template.md`
  - `release-evidence/PHASE_07-accessibility-evidence-2026-03-20.md`
  - `release-evidence/PHASE_07-automated-a11y-smoke-2026-03-20.md`
  - `release-evidence/PHASE_07-coverage-by-family-2026-03-20.md`

# High-level findings

- Overall verdict: `NOT PRODUCTION READY` for the requested React + Svelte GA bar. The documented release gate passes, but the full audit found `3 PASS`, `15 PARTIAL`, and `7 FAIL` outcomes across the 25 spec requirements.
- The strongest release blocker is Svelte determinism and verification integrity. Three GA Svelte surfaces still generate public IDs with `Math.random()` (`uifn/svelte/src/Dialog.svelte:52`, `uifn/svelte/src/AlertDialog.svelte:37`, `uifn/svelte/src/Tabs.svelte:36`), while the Svelte build config explicitly filters `state_referenced_locally` compiler warnings (`uifn/svelte/tsup.config.ts:13-18`).
- Svelte modal semantics remain below the GA contract. `DialogContent.svelte` and `AlertDialogContent.svelte` implement focus trapping and Escape handling, but there is no body-scroll lock logic anywhere in the Svelte dialog sources, so `DLG-001` is not met even though the package tests pass.
- The release evidence for manual accessibility is not actual manual accessibility verification. The only “manual” evidence record declares `JSDOM via Vitest + Testing Library` and “manual announcement-contract review” rather than a real browser + assistive-tech run (`uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/release-evidence/PHASE_07-accessibility-evidence-2026-03-20.md:7-10`).
- Runtime contract hardening is incomplete in both adapters. React contains 32 plain `throw new Error(...)` context failures, and Svelte contains 65 unchecked `getContext<any>(...)` call sites, so canonical `UIFnError` handling is not consistently enforced at the adapter boundary.
- The legacy root spec is still broader than the shipped API. `uifn/SPEC.md` continues to advertise parts and behaviors not exported by the React/Svelte adapters, so the docs/spec surface is not yet fully truthful even though package READMEs were improved.

# Intent Inventory

1. `uifn` must be production-ready, not partially hardened.
2. React must be explicitly release-blocking and production-ready.
3. Svelte must be explicitly release-blocking and production-ready.
4. `uifn` is a framework-agnostic, unstyled, accessible primitives family with a shared core and framework adapters.
5. The canonical public package contract is `@uifn/core` (GA), `@uifn/react` (GA), `@uifn/svelte` (GA), with `@uifn/vue` and `@uifn/files` public but experimental.
6. Unsupported adapters such as Solid and web-components must not be advertised as supported.
7. Display helpers remain in scope: `Avatar`, `Badge`, `Label`, `Separator`, and adapter-only `VirtualizedList`.
8. `AvatarFallback` behavior must be deterministic, including delayed fallback rendering.
9. `VirtualizedList` must remain deterministic, adapter-only, and use `overscan=3` by default.
10. Compatibility claims must remain truthful for Node `18.x/20.x/22.x`, React `18.2+`, Svelte `5.x`, and evergreen browsers.
11. A stable, one-command release gate must exist and be documented.
12. `@uifn/core` must own the authoritative semantics for shared GA primitive families.
13. Public IDs, hydration behavior, and exported utilities must be deterministic.
14. Runtime misuse must fail canonically through `UIFnError`, and production bundles must not leak ad hoc debugging output.
15. Accessibility, keyboard navigation, focus management, ARIA wiring, and reduced-motion correctness are first-class requirements.
16. Controlled and uncontrolled state must remain stable across disclosure, form, menu, select, combobox, and dialog families.
17. Dialog, popup, menu, select, combobox, range, and scroll surfaces must be production-grade rather than placeholder-level.
18. React must expose a typed, ref-safe, SSR/hydration-safe public API, including `asChild` where claimed.
19. Svelte must expose typed public components, react correctly to controlled prop updates, and build without suppressed GA warnings.
20. Documentation, support matrix, package boundaries, automated coverage, and genuine manual accessibility evidence must all be truthful enough to support a GA release.

# Intent → Spec coverage matrix

| Intent # | Intent summary | Spec coverage | Requirement IDs | Coverage result |
| --- | --- | --- | --- | --- |
| 1 | Production-ready release, not a partial hardening pass | Bundle `Overview`, `Semantics`, `Invariants`, `Definition of Done` | `REL-001` through `COMPAT-001` | Covered |
| 2 | React is release-blocking GA scope | Bundle `Overview`, `Adapter semantics`, `Compatibility / versioning strategy` | `REACT-001`, `REACT-002`, `QA-001`, `QA-002`, `COMPAT-001` | Covered |
| 3 | Svelte is release-blocking GA scope | Bundle `Overview`, `Adapter semantics`, `Compatibility / versioning strategy` | `SVELTE-001`, `SVELTE-002`, `QA-001`, `QA-002`, `COMPAT-001` | Covered |
| 4 | Shared-core, unstyled, accessible primitives family | Root `uifn/SPEC.md` core principles; bundle `Goals / Non-goals`, `Semantics` | `CORE-001`, `CORE-004`, family requirements | Covered |
| 5 | Canonical GA and experimental package identities | Root `README.md`, root `SPEC.md` Phase 0 baseline, bundle `Release surface semantics` | `REL-001`, `DOCS-001`, `FILES-001` | Covered |
| 6 | Unsupported adapters must not be claimed | Root `README.md`, root `SPEC.md` support claims, bundle `Release surface semantics` | `REL-001`, `DOCS-001` | Covered |
| 7 | Display helpers are in-scope public contract | Root `README.md` display-helper contract, bundle `Adapter family catalog` | `SIMPLE-001`, `DOCS-001` | Covered |
| 8 | Avatar fallback behavior must be deterministic | Root/package READMEs, bundle `Adapter family catalog`, `Selection semantics` | `SIMPLE-001` | Covered |
| 9 | VirtualizedList is adapter-only with deterministic overscan | Root/package READMEs, bundle `Adapter family catalog`, `Limits/caps` | `SIMPLE-001`, `QA-001` | Covered |
| 10 | Compatibility claims must be truthful | Root `README.md`, root `SPEC.md`, package READMEs/manifests, bundle `Compatibility / versioning strategy` | `REL-001`, `DOCS-001`, `COMPAT-001` | Covered |
| 11 | Stable documented release gate command | Root `README.md`, root `SPEC.md`, bundle `Release-gate command` | `REL-003` | Covered |
| 12 | Core owns shared semantics | Bundle `Core ownership semantics` | `CORE-001` | Covered |
| 13 | Deterministic IDs, hydration safety, utility exports | Root `SPEC.md` utilities/id generation, bundle `Invariants`, `Adapter semantics` | `CORE-002`, `REACT-002`, `SVELTE-001` | Covered |
| 14 | Canonical runtime errors and no debug leakage | Bundle `Canonical runtime error envelope`, `Observability` | `CORE-003` | Covered |
| 15 | Accessibility, keyboard, focus, reduced-motion correctness | Root `SPEC.md` accessibility/testing sections, bundle `Accessibility semantics` | `CORE-004`, `QA-002` | Covered |
| 16 | Stable controlled/uncontrolled behavior | Root `SPEC.md` common patterns, bundle `Controlled and uncontrolled semantics` | `DISC-001`, `FORM-001`, `SEL-001`, `CMB-001`, `SVELTE-001` | Covered |
| 17 | Production-grade popup/menu/select/range/scroll families | Root `SPEC.md` primitive catalog, bundle `Popup/Selection/Range semantics` | `DLG-001`, `POP-001`, `MENU-001`, `SEL-001`, `CMB-001`, `RANGE-001`, `SCROLL-001` | Covered |
| 18 | React typed/ref-safe/SSR-safe API | Root/package React docs, bundle `React` adapter semantics | `REACT-001`, `REACT-002` | Covered |
| 19 | Svelte typed/reactive/warning-free build | Package Svelte README, bundle `Svelte` adapter semantics | `SVELTE-001`, `SVELTE-002` | Covered |
| 20 | Truthful docs, QA coverage, and real manual accessibility evidence | Root docs + bundle `Documentation and support matrix semantics`, release evidence files | `DOCS-001`, `QA-001`, `QA-002`, `FILES-001` | Covered |

No intent item was missing from the bundle. The remaining problems are implementation failures, evidence failures, and explicit spec conflicts between the legacy root spec and the newer audit-fix bundle.

# Requirement coverage summary

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED |
| --- | ---: | ---: | ---: | ---: |
| `2026-03-20-audit-fix-dhrtycgi-spec` | 3 | 15 | 7 | 0 |

# Requirement-by-requirement results

| ID | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `REL-001` | PARTIAL | `uifn/README.md`; package manifests; `scripts/verify-uifn-release.mjs` | Canonical names/statuses are aligned in package READMEs and manifests, but a fresh-consumer smoke install/typecheck was not actually executed during this audit. |
| `REL-002` | PASS | `npm run verify:uifn-release`; `npm pack --dry-run` output for core/react/svelte/files | Public tarballs are clean, typed, and exclude tests from published contents. |
| `REL-003` | PARTIAL | `npm run verify:uifn-release -- --dry-run`; `npm run verify:uifn-release`; `uifn/svelte/tsup.config.ts:13-18` | One-command release verification exists and passes, but the Svelte build stage suppresses compiler warnings that the GA contract says must be absent, so the gate is not yet fully trustworthy. |
| `CORE-001` | PARTIAL | `uifn/react/src/dialog.tsx`, `uifn/react/src/tabs.tsx`, `uifn/react/src/checkbox.tsx`, `uifn/svelte/src/Tabs.svelte`, `uifn/svelte/src/Collapsible.svelte` | Core factories exist, but adapter ownership is still inconsistent. React duplicates significant state/interaction logic instead of binding to core machines, and Svelte Tabs is also adapter-owned. |
| `CORE-002` | FAIL | `uifn/svelte/src/Dialog.svelte:52`; `uifn/svelte/src/AlertDialog.svelte:37`; `uifn/svelte/src/Tabs.svelte:36`; `uifn/react/src/dialog.tsx:110,233`; `uifn/react/src/select.tsx:130,287`; `uifn/svelte/src/SelectTrigger.svelte:30`; `uifn/svelte/src/SelectContent.svelte:41` | Deterministic ID invariants are broken. Svelte still uses `Math.random()` for public IDs, and both adapters also hardcode shared content IDs such as `dialog-content`, `select-content`, and `combobox-content`, creating duplicate-instance collision risk. |
| `CORE-003` | FAIL | Core `UIFnError` exists in `uifn/core/src/errors.ts`; React has 32 `throw new Error(...)` sites; Svelte has 65 unchecked `getContext<any>(...)` sites | Adapter misuse does not consistently throw canonical `UIFnError`. Production-safe debug logging looks clean, but the canonical failure envelope contract is not met. |
| `CORE-004` | PARTIAL | React/Svelte axe smoke passed; Svelte Tabs keyboard code in `uifn/svelte/src/TabsTrigger.svelte:36-43`; no reduced-motion code found by search | Baseline roles/focus tests exist, but keyboard completeness and reduced-motion evidence are incomplete. |
| `DISC-001` | FAIL | `uifn/svelte/src/TabsList.svelte`; `uifn/svelte/src/TabsTrigger.svelte:36-43`; `uifn/svelte/src/tabs.test.ts` | Svelte Tabs does not implement Arrow/Home/End navigation or roving-focus semantics required by the spec; its tests only cover click switching. |
| `FORM-001` | PASS | `uifn/react/src/checkbox.tsx`; `uifn/react/src/switch.tsx`; `uifn/react/src/radio-group.tsx`; `uifn/svelte/src/Checkbox.svelte`; `uifn/svelte/src/Switch.svelte`; `uifn/svelte/src/RadioGroup.svelte` | Checkbox/Switch/RadioGroup expose correct roles/ARIA and hidden form inputs, and their basic semantics are covered by passing tests. |
| `DLG-001` | FAIL | `uifn/svelte/src/DialogContent.svelte:1-40`; `uifn/svelte/src/AlertDialogContent.svelte:1-49`; absence of any body-scroll-lock logic in Svelte dialog sources; tests only `opens and closes` | The Svelte adapter does not implement body scroll locking for modal dialogs/alert dialogs, so modal semantics remain incomplete even though focus trap and Escape handling exist. |
| `POP-001` | PARTIAL | React/Svelte popup tests; shared positioning utilities reused in React hooks and Svelte internal actions | Positioning/dismissal basics are present, but browser-level cleanup and reduced-motion-safe behavior were not verified beyond jsdom-style tests. |
| `MENU-001` | PARTIAL | Core dropdown/context/menu-bar tests pass; adapter tests are basic; root spec vs bundle differ on submenu public surface | Menu-family basics exist, but the audit did not find evidence for the documented 3-level submenu cap, and the legacy spec still overclaims submenu/check/radio public parts. |
| `SEL-001` | PARTIAL | `uifn/react/src/select.tsx`; `uifn/svelte/src/Select.svelte`; passing select tests | Controlled open/value and hidden input behavior are present, but both adapters hardcode `select-content`, so multi-instance ARIA correctness is not production-grade yet. |
| `CMB-001` | PARTIAL | `uifn/react/src/combobox.tsx`; `uifn/svelte/src/Combobox.svelte`; passing combobox tests; root `uifn/SPEC.md:257-293` | Basic filtering/highlighting/select behavior is covered, but duplicate ID risk remains and the root spec still advertises multiple-selection and `ComboboxEmpty` surface that the adapters do not export. |
| `RANGE-001` | PARTIAL | Core slider/progress tests pass; adapter tests cover only basic cases | Core semantics exist, but adapter verification does not prove the full multi-thumb/value-contract GA bar. |
| `SCROLL-001` | PARTIAL | Core `scroll-area` tests; adapter tests basic | Basic behavior exists, but the audit did not find exhaustive drag/geometry/corner synchronization evidence at the published contract depth. |
| `SIMPLE-001` | PARTIAL | Display-helper docs/tests present; `VirtualizedList` tests in React/Svelte use 200 items | Helper public contracts are now explicit, but the published limit/cap expectations are not actually verified at scale. |
| `REACT-001` | PARTIAL | `uifn/react/src/dialog.test.tsx`; typed exports build; `asChild` on Dialog | The React adapter is typed and largely ref-safe, but it still duplicates core semantics, throws plain `Error`, and relies on fixed content IDs in several public popup/select surfaces. |
| `REACT-002` | PARTIAL | React build/lint/test/pack all passed; SSR hydration smoke passed | React is close to the target bar, but the duplicate fixed-ID issue and lack of fresh-consumer smoke testing keep it below a clean GA verdict. |
| `SVELTE-001` | FAIL | `uifn/svelte/src/Dialog.svelte:29-37,52`; `uifn/svelte/src/AlertDialog.svelte:37`; `uifn/svelte/src/Tabs.svelte:35-43`; `uifn/svelte/tsup.config.ts:13-18` | Svelte GA surfaces still have nondeterministic IDs, incomplete keyboard semantics, and a build that suppresses the exact warning class the requirement says must not exist. |
| `SVELTE-002` | PARTIAL | Svelte build/lint/test/pack passed; tarball is clean; `src/index.d.mts` is published | Tooling is much healthier than the prior audit found, but the build masks compiler warnings and does not emit declarations as part of the build itself. |
| `DOCS-001` | FAIL | `uifn/SPEC.md:257-324`; `uifn/SPEC.md:786-796`; `uifn/SPEC.md:953-957`; adapter indexes do not export those surfaces | Package READMEs are mostly aligned, but the legacy root spec still overclaims component parts and testing obligations relative to the shipped public API and evidence. |
| `FILES-001` | PASS | `uifn/files/README.md`; passing pack output for `@uifn/files` | The files package is explicitly documented as Experimental and its tarball is clean. |
| `QA-001` | PARTIAL | Coverage matrix exists and tests pass, but Svelte dialog/tabs and duplicate-ID scenarios are uncovered | The project has broad automated coverage, but not enough coverage on the exact behaviors still failing the spec. |
| `QA-002` | FAIL | `release-evidence/PHASE_07-accessibility-evidence-2026-03-20.md:7-10,17-31` | The “manual” evidence is a jsdom/test-review artifact, not a real keyboard-only + screen-reader verification record in supported environments. |
| `COMPAT-001` | PARTIAL | Docs/manifests align on Node/React/Svelte ranges; release gate passes | Compatibility claims are mostly aligned, but there was no independent smoke install across the supported matrix and the Svelte gate hides a warning class that should remain release-significant. |

# Spec conflicts / spec gaps

- `SPEC CONFLICT`: the legacy root spec still documents a broader component catalog than the audit-fix bundle and the shipped adapters. Examples:
  - `uifn/SPEC.md:257-293` documents `ComboboxViewport`, `ComboboxEmpty`, and multiple selection, while the bundle narrows Combobox to the shipped GA surface and single-selection contract.
  - `uifn/SPEC.md:298-324` documents `ContextMenuCheckboxItem`, `ContextMenuRadioGroup`, `ContextMenuRadioItem`, `ContextMenuSub`, `ContextMenuSubTrigger`, and `ContextMenuSubContent`, while the bundle only guarantees `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, plus documented submenu variants if shipped.
  - `uifn/SPEC.md:790-796` documents `TooltipProvider` and `TooltipArrow`, which are not exported by `uifn/react/src/index.ts` or `uifn/svelte/src/index.ts`.
- `SPEC CONFLICT`: the legacy root spec’s general polymorphism example (`uifn/SPEC.md:862-869`) is broader than the bundle’s “where claimed” React-only contract. The shipped Svelte adapter does not expose a matching `asChild` contract.
- `SPEC GAP`: neither spec document currently gives a precise release-time rule for duplicate-instance ARIA/content IDs on popup/select/combobox surfaces, even though deterministic unique relationships are implicitly required by `CORE-002`.
- `SPEC GAP`: the bundle’s manual accessibility requirement is clear, but the release evidence artifact did not define the minimum acceptable real-world assistive-tech matrix beyond generic “manual” language, which made the invalid JSDOM-based sign-off easier to produce.

# Cross-cutting audits

## Security / authz / validation boundaries

- No authentication or authorization surface exists inside `uifn`, as expected.
- Static inspection found no use of `dangerouslySetInnerHTML`, `{@html}`, `eval`, or `new Function` in `uifn/core/src`, `uifn/react/src`, or `uifn/svelte/src`.
- Validation boundaries are still weak at adapter context edges:
  - React relies heavily on plain `throw new Error(...)` context assertions.
  - Svelte mostly dereferences unchecked `getContext<any>(...)` results, which will degrade into raw `TypeError` behavior when providers are missing.

## Determinism invariants

- `FAIL`
- Deterministic IDs are not fully enforced:
  - `Math.random()` is still used in three GA Svelte root components.
  - fixed IDs such as `dialog-content`, `alert-dialog-content`, `select-content`, `combobox-content`, `dropdown-menu-content`, and `popover-content` are still used in public adapter surfaces.
- This creates a real risk of duplicate-instance ARIA collisions and undermines the SSR/hydration guarantees called out in both the root spec and the bundle.

## Limits / caps

- `PARTIAL`
- The project now has virtualized-list tests, but they only exercise 200 items in both React and Svelte. The bundle’s 10,000-item and under-200-mounted-node cap is not directly verified.
- The audit found no direct evidence for:
  - 500-item Select/Combobox validation
  - 25 queued toast items
  - 3-level submenu verification
- These are currently spec-level promises without matching release evidence.

## Error handling + canonical envelopes

- `FAIL`
- `@uifn/core` defines a solid `UIFnError` model in `uifn/core/src/errors.ts`, but that contract has not been propagated consistently to the adapters.
- Because adapters still emit plain `Error` or raw context misuse failures, the canonical runtime error envelope is only partially implemented in the package family that users actually consume.

## Compatibility / versioning / migrations

- `PARTIAL`
- Versioning and compatibility claims are mostly aligned:
  - package manifests and READMEs agree on Node/React/Svelte ranges
  - changelogs exist for the public packages
  - the local release gate runs cleanly
- Remaining issues:
  - no independent supported-matrix smoke install was executed
  - the Svelte verification path hides a compiler-warning class that should remain visible for GA enforcement
  - the legacy root spec still conflicts with the actual shipped API shape

# Recommendations

1. Remove all adapter-side nondeterministic and fixed public IDs.
   Replace `Math.random()` and hardcoded content IDs with per-instance deterministic IDs built from `@uifn/core/utils/id` plus framework-safe ID hooks, then add multi-instance and SSR/hydration tests for dialog/alert-dialog/select/combobox/popover/dropdown surfaces.
2. Stop filtering Svelte compiler warnings in the release path.
   Delete the `state_referenced_locally` filters from `uifn/svelte/tsup.config.ts`, then fix the underlying components until the build is warning-free without suppression.
3. Bring Svelte modal semantics up to the GA contract.
   Add body scroll locking, close-reason semantics, and controlled-mode synchronization to Svelte `Dialog` and `AlertDialog`, and extend tests beyond simple open/close assertions.
4. Make Svelte Tabs use shared core semantics.
   Replace local state/keyboard logic with the core Tabs machine or equivalent shared semantics so Arrow/Home/End/manual-vs-automatic activation match the bundle contract.
5. Normalize adapter runtime failures through canonical `UIFnError`.
   Introduce shared assertion helpers for React and Svelte contexts so missing-provider misuse, invalid values, and semantic contract failures throw typed errors instead of plain `Error` or `TypeError`.
6. Reconcile `uifn/SPEC.md` with the shipped API or ship the missing parts.
   Remove or clearly mark unsupported surfaces such as `ComboboxEmpty`, combobox multiple selection, ContextMenu check/radio/submenu parts, and `TooltipProvider`/`TooltipArrow` until they truly exist in the public adapters.
7. Produce real QA-002 evidence.
   Run keyboard-only and screen-reader verification in actual supported environments, capture the browser/OS/AT matrix used, and replace the current JSDOM-based sign-off artifact.
8. Add consumer-level smoke verification.
   Extend the release gate with a fresh temporary consumer workspace that installs the packed artifacts, resolves documented subpaths, and runs a minimal typecheck/import smoke for `@uifn/core`, `@uifn/react`, and `@uifn/svelte`.

# Appendix: commands run + environment details

## Key commands run

- `pwd`
- `rg --files uifn`
- `find uifn -maxdepth 3 \( -name 'README.md' -o -name 'SPEC.md' -o -name 'REQUIREMENTS.md' -o -name 'PLAN.md' -o -name 'INTENT_AUDIT.md' -o -path '*/.conduct/*' \) | sort`
- `git branch --show-current && git rev-parse HEAD && git status --short`
- `wc -l uifn/SPEC.md ...`
- multiple `sed -n ...` reads over the audited docs, spec files, package manifests, and implementation sources cited in this report
- multiple `rg -n ...` searches for export surfaces, warnings, ID generation, runtime errors, coverage evidence, and security-sensitive patterns
- `npm run verify:uifn-release -- --dry-run`
- `npm run verify:uifn-release`
- `date -u +"%Y-%m-%dT%H:%M:%SZ"`
- `uname -a`

## Verification command results

- `npm run verify:uifn-release -- --dry-run`: passed
- `npm run verify:uifn-release`: passed for `@uifn/core`, `@uifn/react`, `@uifn/svelte`, `@uifn/vue`, and `@uifn/files`
- Key caveat from verification:
  - passing the release gate did not invalidate the audit findings above because the gate does not currently catch suppressed Svelte compiler warnings, duplicate-instance ID collisions, or the lack of true manual accessibility evidence

## Environment details

- Current UTC timestamp during report generation: `2026-03-25T06:08:18Z`
- Shell: `/bin/zsh`
- Host OS: `Darwin ArBook.local 25.3.0 Darwin Kernel Version 25.3.0 ... arm64`
