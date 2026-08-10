# PHASE_01 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T05:19:19Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before phase and after phase; pre-existing work and PHASE_00 artifacts were preserved |
| Canonical graph hash | `e7952f1c2fc54b14030799c377f89ec54d5ad44dbae8c51efc3e6f045f24521f` |
| Lockfile hash | `949f429eb144479e048a480f74c6be018a1d0a74c3e90578ba27b8dc705fa613` |

## Phase

- Phase: `PHASE_01`
- Status: **PASS**
- Objective: make React, Svelte, and Solid the only stable frameworks, enforce the stable/private/experimental package graph, remove current Vue/Angular surfaces, and isolate `@uifn/patterns` and `@uifn/sf` from stable release status.

## Requirements summary

### SCOPE-001 — PASS

Acceptance criterion 1: a machine-readable graph lists every stable, private, and experimental workspace and its allowed dependencies.

- `uifn/package-graph.json` declares 16 stable packages, 10 private workspaces, and 2 experimental packages, plus the removed-package policy.
- `uifn/package-graph.schema.json` defines the checked graph shape.
- `scripts/verify-uifn-package-graph.mjs` reconciles the graph with package manifests, exports, workspaces, release rows, and ownership.
- `TV-SCOPE-001-P` passed with canonical graph hash `e7952f1c...` and no cycles.

Acceptance criterion 2: stable packages have no forbidden edge to removed frameworks, experimental packages, private products, tests, examples, Storybook implementation code, or demo code.

- The verifier checks declared dependencies, peer dependencies, package entrypoints, and source imports against package-class rules.
- `@uifn/components` is now framework-neutral; framework-specific styled entrypoints are reserved in `@uifn/components-react`, `@uifn/components-svelte`, and `@uifn/components-solid`.
- `@uifn/dom` is a package boundary marker only. It contains no DOM behavior before its owning phase.

Acceptance criterion 3: undeclared workspaces, cycles, forbidden edges, and missing entrypoint ownership fail closed.

- `TV-SCOPE-001-N` injects a neutral-components-to-React edge and an adapter-kit/core cycle and observes `UIFN_PACKAGE_GRAPH_FORBIDDEN_EDGE` plus `UIFN_PACKAGE_GRAPH_CYCLE` at the exact paths.
- The missing-owner fixture observes the ownership failure independently.
- The contract suite passed 8/8 tests, including stable-only operation with experimental directories absent.

Test status:

- `node --test scripts/verify-uifn-package-graph.test.mjs scripts/verify-uifn-clean.test.mjs scripts/verify-uifn-lanes.test.mjs`: PASS, 8 tests.
- `node scripts/verify-uifn-package-graph.mjs`: PASS, 16 stable, 10 private, 2 experimental, 0 cycles.
- `node scripts/verify-uifn-consumers.mjs`: PASS, three clean packed consumers; each installed and imported only its selected framework peer set.
- `node scripts/verify-uifn-pack.mjs`: PASS, all 16 stable packages packed without forbidden path classes.

### CLEAN-001 — PASS

Acceptance criterion 1: current workspace, lockfile, packed artifacts, docs, generated inventory, registry, source templates, and release gates expose no supported Vue/Angular surface.

- Vue/Angular packages, catalogs, workbenches/playground, registry fixtures, release rows, scripts, dependencies, generated outputs, and framework-specific monolithic component sources were removed.
- `scripts/verify-uifn-clean.mjs` scans 984 current product files while deliberately excluding immutable `.conduct` history; 3,304 historical references remain preserved.
- The cleanup gate also rejects the legacy five-framework count/copy, old `uifn/components/src/<framework>` paths, and stale removed-framework build directories.
- `@uifn/components` performs an explicit prebuild clean, so old framework output directories cannot survive a neutral package rebuild.
- The lockfile contains the 16 stable package rows, the two independent experimental versions, and no removed framework reference.

Acceptance criterion 2: migration documentation identifies the last compatible line and removal impact.

- `uifn/MIGRATION_REMOVED_FRAMEWORKS.md` records the last compatible line, removed packages/surfaces, lack of shims, and consumer migration choices.

Acceptance criterion 3: registry attempts to select a removed framework fail before writing.

- Registry validation accepts exactly React, Svelte, and Solid.
- Removed selections return stable code `UIFN_REGISTRY_UNSUPPORTED_FRAMEWORK` before a filesystem write.
- `uifn/registry/src/__tests__/stable-lane.test.ts` passes six tests covering stable development catalog selection, source installation, and both removed selections.
- `TV-CLEAN-001-N` also injects a removed peer, removed registry choice, legacy five-framework count, and old component source path and observes the intended cleanup codes.

Test status:

- `node scripts/verify-uifn-clean.mjs`: PASS, 984 current files scanned, 9 removed roots/output paths absent, historical records preserved.
- `npm --workspace @uifn/registry run test:stable`: PASS, 6 tests.
- `npm --workspace @uifn/components run build`: PASS; output contains only the neutral root entrypoint.
- `npm --workspace @uifn/components run test`: PASS, neutral-boundary test.
- `npm --workspace @uifn/examples-shared run test -- --run src/__tests__/qa-contract.test.ts`: PASS, 8 tests with the three-framework contract.

### EXP-001 — PASS

Acceptance criterion 1: manifests, changelogs, release channels, docs, and gates identify `patterns` and `sf` as experimental.

- `@uifn/patterns` is `0.2.0-experimental.0`; `@uifn/sf` is `0.1.0-experimental.0` and pins the exact patterns version.
- Both manifests use the `experimental` dist-tag, `releaseLane: experimental`, `stableBlocking: false`, separate changelogs, and explicit experimental documentation.
- `uifn/release-lanes.json` is the machine-readable lane contract.

Acceptance criterion 2: stable verification passes when both experimental packages are absent.

- `npm run verify:uifn-phase-01` temporarily moves both directories under ignored `.conduct` storage, runs the entire stable lane, restores both directories in `finally`, and removes the holding directory.
- The result passed in `experimental-directories-absent` mode. Both package directories were verified restored afterward.

Acceptance criterion 3: experimental failures are reported separately and cannot change stable release status.

- `scripts/verify-uifn-lanes.mjs` returns independent stable and experimental results and derives the top-level result from stable only.
- `TV-EXP-001-N` injects a synthetic patterns failure and a stable-to-`sf` forbidden-edge fixture: the graph rejects the forbidden edge, the experimental result is visibly false, and the stable result remains true.
- `UIFN_EXPERIMENTAL_FAILURE_FIXTURE=patterns npm run verify:uifn-lanes` exits successfully only because the stable lane passed; it does not hide the failed experimental report.

Test status:

- `npm run verify:uifn-experimental`: PASS, two packages, 14 patterns, 14 sf panels, three frameworks, `stableBlocking: false`.
- `npm run verify:uifn-phase-01`: PASS with experimental directories absent.
- Lane contract tests: PASS for `TV-EXP-001-P` and `TV-EXP-001-N`.

## Deliverables summary

### Files added

- `scripts/verify-uifn-package-graph.mjs`
- `scripts/verify-uifn-package-graph.test.mjs`
- `scripts/verify-uifn-clean.mjs`
- `scripts/verify-uifn-clean.test.mjs`
- `scripts/verify-uifn-consumers.mjs`
- `scripts/verify-uifn-stable.mjs`
- `scripts/verify-uifn-experimental.mjs`
- `scripts/verify-uifn-lanes.mjs`
- `scripts/verify-uifn-lanes.test.mjs`
- `scripts/verify-uifn-phase-01.mjs`
- `uifn/package-graph.json`
- `uifn/package-graph.schema.json`
- `uifn/release-lanes.json`
- `uifn/MIGRATION_REMOVED_FRAMEWORKS.md`
- `uifn/dom/README.md`
- `uifn/dom/package.json`
- `uifn/dom/src/index.ts`
- `uifn/dom/tsconfig.json`
- `uifn/dom/vitest.config.ts`
- `uifn/components-react/{README.md,package.json,src/index.ts,tsconfig.json,vitest.config.ts}`
- `uifn/components-svelte/{README.md,package.json,src/index.ts,tsconfig.json,vitest.config.ts}`
- `uifn/components-solid/{README.md,package.json,src/index.ts,tsconfig.json,vitest.config.ts}`
- `uifn/components/src/__tests__/neutral-boundary.test.ts`
- `uifn/registry/src/__tests__/stable-lane.test.ts`
- `uifn/patterns/CHANGELOG.md`
- `uifn/sf/CHANGELOG.md`
- `uifn/.conduct/contracts/fixtures/package-graph/forbidden-edge-cycle.json`
- `uifn/.conduct/contracts/fixtures/package-graph/missing-owner.json`
- `uifn/.conduct/contracts/fixtures/phase-01/removed-framework-reference.json`
- `uifn/.conduct/evidence/phase-01/2026-07-18T051208Z-PHASE-01-e7952f1c.json`
- `uifn/.conduct/specs/2026-07-17-audit-fix-fb19ad09-spec/phase-reports/PHASE_01-2026-07-18-7e39c1ab-report.md`

### Files and current surfaces modified

- `package.json` — graph/cleanup/stable/experimental/lane/phase gates and three-framework workspace scripts.
- `package-lock.json` — regenerated/pruned workspace rows and dependency graph; no removed framework reference.
- `release-packages.json` — exactly the 16 stable uifn release packages; experimental packages are excluded.
- `scripts/verify-uifn-release.mjs` — executes the current stable lane, then fails closed with `UIFN_RELEASE_PROGRAM_INCOMPLETE` until all later phases are complete.
- `uifn/.conduct/contracts/ownership.json` — ownership for all new release gates and target package boundaries.
- `uifn/README.md`, package READMEs, registry docs, examples docs, and support statements — React/Svelte/Solid stable scope and experimental separation.
- `uifn/components/{package.json,README.md,src/index.ts,vitest.config.mts}` — neutral-only exports, dependencies, tests, and clean-build behavior.
- All 45 `uifn/components/registry/components/*.json` manifests and all 45 mirrored `uifn/registry/catalog/components/*.json` manifests — target source paths moved from monolithic framework subtrees to the split component packages.
- `uifn/registry/{README.md,package.json,schemas/component.schema.json}` and `uifn/registry/src/{add.ts,build-registry.ts,cli.ts,schema.ts,validate-catalog.ts}` plus registry tests — three stable choices, pre-write unsupported-framework rejection, and explicit stable/experimental catalog builders.
- `uifn/patterns/{package.json,README.md}` and `uifn/sf/{package.json,README.md}` — independent experimental versions, channels, and non-blocking release metadata.
- `uifn/catalogs/{react,svelte,solid}` package/build surfaces, `uifn/catalogs/landing/index.html`, and `uifn/catalogs/dist/catalog-manifest.json` — three-framework matrix.
- `uifn/examples/{README.md,package.json,scripts/verify.mjs}` and `uifn/examples/shared` contracts/inventories — three-framework equality and counts.
- `uifn/examples/{react,svelte,solid}-workbench/{package.json,tsconfig.json,vite.config.ts}` and component imports — split component-package target aliases.
- Root uifn build, catalog, documentation, examples, components, hooks, registry, browser, accessibility, pattern, sf, and deployment verifiers — three-framework lists and release-lane semantics.

### Files and surfaces deleted

- `uifn/vue/**`
- `uifn/angular/**`
- `uifn/catalogs/vue/**`
- `uifn/catalogs/angular/**`
- `uifn/examples/vue-workbench/**`
- `uifn/examples/angular-workbench/**`
- `uifn/examples/vue-playground/**`
- Removed-framework registry fixtures, generated catalog assets, visual inventory rows, documentation routes, test dimensions, release rows, and dependency/peer/workspace references.
- Former framework implementation trees under `uifn/components/src/{react,svelte,solid,vue,angular}/**`; stable framework targets now belong to the three split packages.
- Stale generated `uifn/components/dist/{vue,angular}/**` output; the neutral package prebuild now removes the entire output directory.

## Verification summary

| Command | Result |
| --- | --- |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` plus lockfile pruning | PASS — clean, parseable lockfile with current workspace versions |
| `node --test scripts/verify-uifn-package-graph.test.mjs scripts/verify-uifn-clean.test.mjs scripts/verify-uifn-lanes.test.mjs` | PASS — 8/8 tests; all six required vectors plus ownership/stable-only checks |
| `node scripts/verify-uifn-package-graph.mjs` | PASS — 16 stable, 10 private, 2 experimental, 0 cycles |
| `node scripts/verify-uifn-clean.mjs` | PASS — 984 active files, 9 removed roots/output paths absent, history preserved |
| `npm run verify:uifn-governance` | PASS — 10/10 checks, 76 owned surfaces |
| `npm --workspace @uifn/components run build && npm --workspace @uifn/components run test` | PASS — clean neutral output and 1/1 contract test |
| `npm --workspace @uifn/registry run test:stable` | PASS — 6/6 tests |
| `npm --workspace @uifn/examples-shared run test -- --run src/__tests__/qa-contract.test.ts` | PASS — 8/8 tests |
| `node scripts/verify-uifn-consumers.mjs` | PASS — React, Svelte, and Solid clean packed consumers |
| `node scripts/verify-uifn-pack.mjs` | PASS — all 16 stable packages |
| `npm run verify:uifn-stable` | PASS — normal stable mode |
| `npm run verify:uifn-phase-01` | PASS — complete stable lane with both experimental directories absent; restoration verified |
| `npm run verify:uifn-experimental` | PASS — separate non-blocking experimental lane |
| `npm run verify:uifn-lanes` | PASS — stable and experimental results both reported |
| `UIFN_EXPERIMENTAL_FAILURE_FIXTURE=patterns npm run verify:uifn-lanes` | PASS — stable true, experimental false, top-level stable result unchanged |
| `npm run verify:uifn-release` | Expected fail-closed — `UIFN_RELEASE_PROGRAM_INCOMPLETE`; no premature 1.0 success |

No required PHASE_01 verification failed. An exploratory full catalog-site build reached the deliberately empty Phase 15 styled-component boundaries and therefore cannot yet export the production component catalog. That command is not a PHASE_01 exit gate; PHASE_02 owns canonical definitions/generated stubs and PHASE_15 owns styled component implementations. The condition is neither hidden nor treated as release-ready.

## Phase audit

- Every `SCOPE-001`, `CLEAN-001`, and `EXP-001` acceptance criterion has a positive and negative vector.
- Stable verification succeeds both normally and with the experimental directories physically absent.
- The cleanup proof covers semantic source scans, exact deleted roots, legacy five-framework assumptions, old component source paths, clean generated output, lockfile state, registry pre-write rejection, packed artifacts, and preserved historical evidence.
- All 16 stable tarballs pack successfully and three isolated consumers resolve/import their public adapter packages without cross-framework peers.
- Stable packages cannot depend on experimental packages; a seeded stable-to-`sf` edge fails at the graph gate.
- Experimental failures remain visible and independently failing without changing stable status.
- `@uifn/dom` and the three styled component packages reserve their graph positions without implementing later-phase behavior.
- There are no compatibility shims for removed packages.
- The phase evidence records a dirty source state honestly and therefore is a phase audit record, not immutable release-candidate evidence.
- Tracker status remains open because PHASE_01 is not the final phase.

## Exact handoff to PHASE_02

PHASE_02 must retain this stable DAG exactly:

1. `@uifn/core`
2. `@uifn/dom`
3. `@uifn/adapter-kit`
4. `@uifn/react`
5. `@uifn/svelte`
6. `@uifn/solid`
7. `@uifn/tokens`
8. `@uifn/theme`
9. `@uifn/recipes`
10. `@uifn/theme-tailwind`
11. `@uifn/components`
12. `@uifn/components-react`
13. `@uifn/components-svelte`
14. `@uifn/components-solid`
15. `@uifn/registry`
16. `@uifn/storybook`

The canonical catalog target is exactly these 61 GA names: Accordion, AlertDialog, AngleSlider, Autocomplete, Avatar, Button, Carousel, Checkbox, CheckboxGroup, Clipboard, Collapsible, ColorPicker, Combobox, ContextMenu, DateInput, DatePicker, Dialog, Drawer, Editable, Field, Fieldset, FileUpload, FloatingPanel, Form, HoverCard, ImageCropper, Input, Listbox, Marquee, Menu, Menubar, Meter, NavigationMenu, NumberInput, Pagination, PasswordInput, PinInput, Popover, Progress, QRCode, RadioGroup, RatingGroup, ScrollArea, SegmentGroup, Select, Separator, SignaturePad, Slider, Splitter, Steps, Switch, Tabs, TagsInput, Timer, Toast, Toggle, ToggleGroup, Toolbar, Tooltip, Tour, and TreeView.

For every name, PHASE_02 must generate deterministic package export inventories, anatomy/type stubs, React/Svelte/Solid adapter coverage manifests, registry metadata targeting `uifn/components-{react,svelte,solid}/src/**`, story/docs/test manifests, and the release matrix. Generation may mark later owning phases and produce stubs, but must not label unimplemented behavior complete.

## Notes

- The repository already contained a large dirty working tree. No unrelated edit was reverted or overwritten.
- Historical `.conduct` evidence still contains removed-framework references by design and is not rewritten.
- Local `node_modules` caches are not product surfaces; the lockfile and packed artifacts are the dependency/release evidence.
- The current Vite CJS deprecation warning in the registry test is non-failing and unrelated to the phase contract.
- No commit or push was created.

## Ready for next phase?

**Yes.** The package classes and allowed dependency directions are enforced, only three stable frameworks remain, experimental products are isolated, and PHASE_02 has exact stable package and catalog targets.

## Blockers

None for PHASE_02 entry. The overall 1.0 program remains incomplete by design and the full release gate continues to fail closed.
