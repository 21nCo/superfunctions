# PHASE_15 execution report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-22T12:38:10Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin 25.4.0 arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after Phase 15; existing user and prior-phase changes were preserved |
| Phase definition hash | `23ca30c25f985d391b2f26ece271659c4fe76a7ce4a8c5d185313b7266c6be72` |
| Lockfile hash | `abff4d8eac0d1a1def427b525bd4c2a169c3c6d84775f64fd0e5328e0d4b5e1b` |
| Canonical Phase 15 evidence | `uifn/.conduct/evidence/phase-15/2026-07-22T12-35-52-000Z-PHASE-15-final/phase-15.json` (`df523ac77c9216d81409541bf8afa0c20d6580b410095564ab52822bdc149a5a`) |
| Clean-consumer evidence | `uifn/.conduct/evidence/phase-15/2026-07-22T12-35-52-000Z-PHASE-15-final/clean-consumers.json` (`7391c068da8cf37234dface83f84614a61949b9cb8eef5fb0859a24553cf960c`) |
| Hook inventory | `uifn/.conduct/inventories/phase-15-hooks.json` (`4a40471b726b99fdbf92c25da071aac34b2cd0afa43860ac1d6c5d483ca26382`) |

## Phase

- Phase: `PHASE_15`
- Status: **PASS**
- Requirements: `COMP-001`, `STYLE-001`, `HOOK-001`
- Vectors: `TV-COMP-001-P/N`, `TV-STYLE-001-P/N`, `TV-HOOK-001-P/N`

## Gate boundary used

The amended Phase 14 gate has two independent conclusions:

1. Semantic implementation parity (`ADAPT-001`, `PARITY-001`) passes and is sufficient to enter Phases 15–18.
2. Signed external compatibility certification (`COMPAT-001`) remains `0/35` and is still mandatory before Phase 19, manual assistive-technology certification, Phase 20, publication, support promises, or any `10/10` readiness claim.

Phase 15 used only the passing semantic-parity evidence. It did not treat local package installs or Phase 15 tarballs as a replacement for the signed compatibility matrix.

## Outcome

Phase 15 replaces the styled-package skeletons and product-demo/factory content with a generated, framework-neutral catalog and three framework-isolated styled compound packages. The catalog has exactly 61 primitives and 419 anatomy parts. React, Svelte, and Solid each expose one styled wrapper per headless part and direct per-primitive subpaths. Styled wrappers add classes and part identity only; interaction, DOM, state, focus, and ARIA remain owned by the corresponding headless package and `@uifn/core`.

Tokens and themes now validate references, fallbacks, cycles, contrast budgets, semantic color use, and required reduced-motion alternatives with stable error codes. Runtime preferences are environment-injected and cover system/light/dark, density, RTL, forced colors, and reduced motion without ambient browser globals. The shared CSS uses semantic custom properties, anatomy/state selectors, preference media queries, and an open cascade contract.

Framework hook inventories and tests now prove eight behavior-neutral capabilities across React, Svelte, and Solid. Outside interaction, Escape routing, focus/layer behavior, and primitive state stay in the shared core/DOM ownership boundary.

The canonical verifier passed all 29 executable checks and killed all eight seeded defects. The three clean consumers installed only their own framework packages, validated root and `button` subpath entries, and found zero forbidden framework dependencies.

## Requirements summary

### `COMP-001` — PASS

1. `@uifn/components` is framework-neutral definitions, contracts, metadata, and CSS only.
2. `@uifn/components-react`, `@uifn/components-svelte`, and `@uifn/components-solid` each cover 61 primitives / 419 parts through generated direct delegates.
3. Product-scene runtime content and styled behavior forks are absent from reusable package sources; seeded product-content and behavior-fork mutations are rejected.
4. Package exports include tree-shakeable primitive subpaths. React imports the packed `button` subpath at runtime; Svelte and Solid packed compiled subpaths are resolved and inspected in isolated consumers.
5. The inherited Phase 14 public-tree corpus remains green: 366/366 golden comparisons, 183/183 cross-install comparisons, and all three semantic mutations killed.

### `STYLE-001` — PASS

1. Token references resolve deterministically and fail on missing references, missing fallbacks, and cycles.
2. Contrast budgets, semantic-color indirection, and reduced-motion alternatives use exact fail-closed diagnostics.
3. First-party themes include reduced-motion token alternatives; runtime preference resolution is injected, subscribable, and cleanup-safe.
4. Shared CSS covers density, RTL, forced colors, reduced motion, focus visibility, disabled/error/selection states, anatomy selectors, and consumer override variables without hardcoded semantic colors.
5. Token tests passed 11/11; theme tests passed 8/8; recipe tests passed 7/7; Tailwind bridge tests passed 2/2. The low-contrast and required-motion mutations were killed.

### `HOOK-001` — PASS

1. The checked inventory contains eight required capabilities with React, Svelte, and Solid bindings and explicit core/DOM behavior ownership.
2. Hook suites passed React 3/3, Svelte 4/4, Solid 3/3, and DOM 3/3.
3. SSR media-query behavior, client subscription, cleanup, and explicit clipboard failure paths are verified.
4. Source scans reject ambient `window`/`document` access and framework-local outside-interaction behavior. Both seeded violations were killed.

## Deliverables summary

Major deliverables:

- `scripts/generate-uifn-phase-15.mjs` — deterministic 61-component / 419-part catalog and wrapper generation.
- `scripts/verify-uifn-phase-15.mjs` and contract tests — positive, negative, dependency, source, preference, hook, package, and parity gates.
- `scripts/verify-uifn-phase-15-consumers.mjs` — packed one-framework clean installs and primitive-subpath checks.
- `scripts/verify-uifn-hooks.mjs` and `uifn/.conduct/inventories/phase-15-hooks.json` — cross-framework hook ownership and lifecycle verification.
- `uifn/components` — neutral catalog/contracts/CSS; legacy reusable product behavior/content removed from runtime source.
- `uifn/components-react`, `uifn/components-svelte`, `uifn/components-solid` — isolated generated styled compounds and per-primitive exports.
- `uifn/tokens`, `uifn/theme`, `uifn/theme-tailwind`, and `uifn/recipes` — validated token/theme/preference/recipe contracts.
- Updated package documentation for neutral CSS and framework-specific root/subpath consumption.

## Verification summary

| Check | Result |
| --- | --- |
| Phase 15 static contract tests | 4 pass, 0 fail |
| Generator drift check | 61 components, 419 parts, pass |
| Workspace typecheck/test/build matrix | 8 workspaces, all requested commands pass |
| Styled part coverage | React 419, Svelte 419, Solid 419 |
| React styled representative runtime render | pass |
| Svelte styled catalog compiler check | 0 errors, 0 warnings |
| Solid styled structural/build check | pass |
| Hook verifier | DOM 3/3, React 3/3, Svelte 4/4, Solid 3/3 |
| Clean packed consumers | React, Svelte, Solid pass; zero forbidden framework packages |
| Primitive subpath proof | React runtime import; Svelte/Solid compiled `button` entry validation |
| Phase 14 semantic parity replay | 366/366 golden; 183/183 cross-install; 3/3 mutations killed |
| Phase 15 mutations | 8/8 killed |
| Consolidated Phase 15 verifier | 29/29 checks pass; 0 failures |
| `git diff --check` | pass |

## Notes and limits

- Phase 15 is complete under the semantic implementation gate. The older Phase 14 reports that said Phase 15 was locked predate the approved gate split and are retained as historical evidence.
- The Phase 14 signed external compatibility certificate remains open at `0/35`. No release, browser-support, device-support, manual assistive-technology, or `10/10` readiness claim follows from this report.
- Svelte and Solid clean consumers validate their compiled framework entries rather than importing `.svelte`/`.jsx` through bare Node. Framework-native runtime and browser matrices continue in Phases 16–18; Phase 20 owns final bundle budgets and release certification.
- The existing Node-20 engine warning for `rollup-plugin-visualizer@7.0.1` appeared during the lockfile-only install. The install and Phase 15 gate completed; release tooling remains standardized on the versions defined by later certification phases.
- No commit, push, pull request, trusted workflow dispatch, publication, or deployment occurred.
- The tracker was not advanced because Phase 20 is the final tracker-closing phase.

## Rollback notes

Rollback must keep the neutral/styled package boundary coherent: revert the generator, generated wrappers, manifests/exports, neutral CSS/contracts, token/theme changes, hook inventory, verifiers, tests, and lockfile together. Do not restore product-specific runtime content or framework-local primitive behavior. If direct subpaths are removed, remove the corresponding package exports and clean-consumer assertions rather than leaving dead metadata. Never weaken the Phase 14 signed compatibility gate as part of a Phase 15 rollback.

## Ready for next phase?

**Yes — Phase 16.** The amended sequencing allows the examples/reference-app phase to proceed from passing semantic parity while signed compatibility remains independently release-blocking.

## Blockers

None for Phase 15 or entry to Phase 16. The signed external compatibility matrix remains a later Phase 19/20 and release blocker.
