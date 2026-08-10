# PHASE_06 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T09:54:32Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the phase; user and earlier-phase changes were preserved |
| Phase definition hash | `f61cf018edcbbfdbf987e0e9fd8e6868f3e6989b3356a7fbbb1d7c6a994612fb` |
| Lockfile hash | `9a78346e07fc1dcc9418d2adb7172ceb81c0dde7cbac9112045f8d3a9d85b6c7` |
| Evidence | `uifn/.conduct/evidence/phase-06/2026-07-18T093725Z-PHASE-06-b9a41bc3.json` |

## Phase

- Phase: `PHASE_06`
- Status: **PASS**
- Requirements delivered: `CAT-002`, `PRIM-001`
- Objective: create the canonical shared collection/navigation/selection/range substrate and implement the 14 foundational, static, disclosure, identity, and scroll primitives without duplicate behavior or unnecessary runtime cost.

## Outcome

`@uifn/core` now exposes one canonical algorithm layer for collections, tree collections, navigation, selection, locale/value-text matching, typeahead, range normalization, deterministic IDs, virtualization, and cancellable async lists. Existing Accordion, Toolbar, Select, Combobox, Slider, utility, and environment call sites delegate to that layer instead of carrying private variants.

All 14 Phase 06 primitives have public core implementations. Nine are pure typed static contracts with no controller lifecycle, subscriptions, effects, actions, or destroy path. Five retain controllers because they own real interaction: Accordion, Collapsible, ImageCropper, ScrollArea, and Toolbar. Avatar and Separator were specifically corrected from temporary controller-shaped implementations to static contracts.

Core package and bundled-source fixtures exercised all 14 public contracts in React-, Svelte-, and Solid-labeled thin modes. Each mode executed nine static contracts and five controllers through public state/parts APIs. These are intentionally not polished framework component implementations; Phases 11–13 own those adapters.

The authoritative phase gate passes. It includes model/property tests, controlled-negative classifiers, generated-artifact drift, two byte-identical full core builds, a real `npm pack`, clean package import, source bundle import, Node 20/22/24 DOM-free imports, controller/runtime regression gates, all three framework typechecks, the canonical catalog generator, governance, clean consumers, pack hygiene, and the complete stable aggregate.

This is development-phase evidence from a dirty working tree. It is not immutable release-candidate evidence and does not claim overall 1.0, polished adapter, browser, assistive-technology, or accessibility 10/10 readiness.

## Canonical shared algorithms

There are nine canonical source modules under `uifn/core/src/algorithms/`:

| Module | Public capability | Invariants and policies |
| --- | --- | --- |
| `collection.ts` | `ListCollection`, `TreeCollection`, key reconciliation | Immutable inputs, stable unique keys, enabled-key projection, deterministic lookup/order, mutation-safe active-key reconciliation, cycle rejection for expanded trees. |
| `navigation.ts` | collection/index navigation | Orientation-aware Home/End/arrow movement, loop policy, disabled skipping, and RTL horizontal inversion. |
| `selection.ts` | `ListSelection` | Single/multiple modes, replace/toggle behavior, range selection over enabled keys, anchor/focus ownership, and mutation reconciliation. |
| `locale.ts` | `LocaleMatcher`, value-text normalization | Unicode NFKD normalization, locale-aware `Intl.Collator` equality/prefix matching, and canonical item value text. |
| `typeahead.ts` | pure typeahead state and matching | Timeout reset, locale matching, current-key-relative search, disabled exclusion, and repeated-character cycling. |
| `range.ts` | normalization, alignment, percentage/value mapping, key stepping | Finite bounds, positive steps, clamping, precision-safe step alignment, sorted multi-values, idempotence, RTL/orientation-aware keyboard steps. |
| `id.ts` | token normalization and scoped part IDs | Deterministic, SSR-stable, normalized instance/primitive/part IDs with stable invalid-input errors. |
| `virtualization.ts` | `VirtualizerContract` | Deterministic total size, overscanned windows, index offsets, and extension points without requiring every item in the DOM. |
| `async-list.ts` | `AsyncList` | Monotonic request IDs, `AbortSignal` cancellation, stale-result suppression, status/error state, and deterministic destroy behavior. |

The generated capability manifest names nine top-level algorithm capabilities: AsyncList, ListCollection, TreeCollection, ListSelection, LocaleMatcher, CollectionNavigation, Range, Typeahead, and VirtualizerContract. Deterministic ID functions remain public cross-cutting helpers and are exported from `@uifn/core/algorithms` and the core root.

## Generated-sequence seeds and traces

The collection mutation model uses deterministic linear-congruential generation for seeds `1` through `64`. Every seed executes `80` operations, for `5,120` mutation steps total. Operations cover insertion, removal, reorder, and disabled-state mutation while comparing the implementation to an independent enabled-key projection and expected navigation result after each step.

Range properties replay seeds `1` through `32` over arbitrary out-of-range floating-point values. Every normalized result is checked for bounds, sorted order, step alignment, and idempotence.

Additional deterministic traces cover:

- duplicate collection keys and disabled-first reorder;
- French, Turkish, and German Unicode/collation cases;
- repeated-character typeahead cycling;
- single, toggle, range, and mutation-safe selection;
- a 10,000-item virtualized window;
- tree expansion followed by an injected cycle;
- two overlapping async loads where request 1 is aborted and only request 2 publishes.

The traces contain synthetic keys and labels only. No user data is recorded. A failing generated-sequence assertion can be replayed from the fixed seed and operation count; no random wall-clock source participates.

## Primitive completeness

| Primitive | Core kind | Canonical behavior delivered |
| --- | --- | --- |
| Accordion | interactive controller | Disclosure state, single/multiple policy, mutation-safe collection focus, native button activation, heading level, trigger/panel IDs, `aria-expanded`/`aria-controls`, and conditional region semantics. |
| Avatar | typed static contract | Root/image/fallback anatomy, native image `alt`, deterministic parts, and no core image-loading state machine. |
| Button | typed static contract | Native `button`, default `type="button"`, disabled/loading behavior, busy state, and optional pressed semantics without synthetic role/activation. |
| Collapsible | interactive controller | Controlled/uncontrolled disclosure state, deterministic trigger/content relations, native button click activation, and no duplicate Enter/Space handler. |
| Field | typed static contract | Deterministic label/control/description/error IDs, native label `for`, required/invalid state, described-by composition, and alert error semantics. |
| Fieldset | typed static contract | Native `fieldset`/`legend`, disabled/invalid data, and description/error relationships. |
| Form | typed static contract | Native `form` ownership, name/method/action/no-validate attributes, and no controller for browser-owned submission behavior. |
| ImageCropper | interactive controller | Loading/error state, controlled crop/zoom, bounded drag and resize, aspect/min/max constraints, disabled behavior, slider semantics, labeled resize handles, and deterministic SSR parts. |
| Input | typed static contract | Native `input`, type/name/value/required/disabled/read-only/autocomplete attributes, and invalid/busy semantics. |
| Marquee | typed static contract | Static root/content anatomy, speed/direction data, and explicit reduced-motion pause/stop behavior without timers or effects in core. |
| QRCode | typed static contract | Required value and accessible label validation, error-correction/size state, figure/svg/figcaption anatomy, deterministic image naming, and stable `UIFN_ERR_INVALID_VALUE` failures. Matrix rendering remains adapter output over this catalog contract. |
| ScrollArea | interactive controller | Viewport metrics, vertical/horizontal availability, keyboard scroll commands, direction/orientation policy, and synchronized scrollbar min/max/current values. |
| Separator | typed static contract | Semantic separator or decorative presentation role, orientation, and deterministic root part with no controller lifecycle. |
| Toolbar | interactive controller | Accessible label, orientation, loop policy, disabled-aware collection roving focus, RTL horizontal movement, mutation-safe reorder, and native item props. |

Completeness is `14/14`: nine static contracts and five interactive controllers. The phase generator emits the complete export inventory, type union, and test manifest and rejects drift.

## Native and accessibility design basis

The implementation follows the catalog's native-first rule. Native `button`, `input`, `form`, `fieldset`, `legend`, and label relationships are retained instead of being replaced by generic elements with roles. Interactive ARIA augments native semantics only where the pattern requires state or relationships.

The design basis reviewed for this phase was:

- W3C APG Accordion Pattern: `https://www.w3.org/WAI/ARIA/apg/patterns/accordion/`
- W3C APG Toolbar Pattern: `https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/`
- WHATWG HTML forms: `https://html.spec.whatwg.org/multipage/forms.html`

Automated Phase 06 proof covers native elements, roles, accessible names, required/invalid/busy/pressed/expanded/value attributes, deterministic relationships, disabled behavior, reduced motion, SSR output, and form attributes. Real browser and assistive-technology confidence is not inferred from these unit/package checks; Phases 14, 18, and 19 still own that evidence.

## Static-runtime boundary

`defineUIFnStaticContract()` establishes a frozen, typed contract with only:

- `kind` and `name`;
- immutable anatomy;
- pure `getState(inputs)`;
- pure `getParts(inputs, context)`.

The nine static contracts expose no `subscribe`, `actions`, `destroy`, timer, observer, or effect surface. The controlled-negative vector classifies an introduced static runtime lifecycle as `UIFN_STATIC_RUNTIME_COST`.

Avatar and Separator controller facades introduced during the Phase 04 transition were removed. Their migration entries now point to `AvatarContract` and `SeparatorContract`. React no longer exports generic `useAvatar`/`useSeparator` controller hooks, Solid no longer creates those generic controllers, and Svelte's image load rendering state remains framework-local rather than turning static core semantics into a shared controller.

## Duplicate implementations removed or delegated

| Previous duplicate/owner | Canonical result |
| --- | --- |
| Utility/environment ID composition | Delegates to `algorithms/id.ts`. |
| Utility roving-focus index traversal | Delegates to `algorithms/navigation.ts`. |
| Primitive-local clamp/step alignment | Delegates to `algorithms/range.ts`; Slider uses the same range rules. |
| Accordion and Toolbar item traversal | Uses canonical collections and navigation. |
| Select local collection filtering, navigation, and typeahead | Uses ListCollection, CollectionNavigation, and Typeahead. |
| Combobox duplicate-key filtering, text comparison, navigation, and virtualization shape | Uses canonical collection, locale, navigation, and virtualization contracts; duplicate keys now fail rather than silently using last-write-wins. |
| Avatar and Separator state-machine facades | Replaced by zero-lifecycle static contracts. |
| Node import smoke and Phase 03 runtime benchmark references to Avatar's removed controller | Node smoke exercises `AvatarContract`; runtime benchmark uses the interactive Toggle controller. |

The Phase 06 contract verifier also scans for reintroduced forks. The controlled-negative classifier emits exactly `UIFN_SHARED_ALGORITHM_FORK` or `UIFN_COLLECTION_INVARIANT` for the algorithm family.

## Requirement and vector evidence

| Requirement | Positive evidence | Controlled negative evidence | Status |
| --- | --- | --- | --- |
| `CAT-002` | Nine canonical algorithm modules; 5,120 collection mutation steps; range properties; Unicode/locale, tree, async, virtualization, selection, RTL, IDs; existing primitives delegate to shared modules | Algorithm fork and collection invariant mutations are classified as `UIFN_SHARED_ALGORITHM_FORK` and `UIFN_COLLECTION_INVARIANT` | PASS |
| `PRIM-001` | All 14 public core contracts; native/a11y/form/SSR tests; nine zero-runtime statics; five behavior controllers; 84 package/source exercises across three labeled modes | Lost native semantics and added static lifecycle mutations are classified as `UIFN_NATIVE_SEMANTIC_LOST` and `UIFN_STATIC_RUNTIME_COST` | PASS |

The controlled-negative verifier has three tests and all pass. It checks exact error classifications rather than treating a generic non-zero exit as sufficient proof.

## Package, source, and reproducibility proof

`scripts/verify-uifn-foundation-pack.mjs` performs a real prepack build, creates the core tarball, extracts it, installs it into a clean temporary consumer, bundles the core source independently, and imports both implementations. It then exercises all nine static and five interactive public contracts for each of the React, Svelte, and Solid fixture labels.

- Package-mode exercises: `42`.
- Source-mode exercises: `42`.
- Total exercises: `84`.
- Local/prepack/extracted ESM entrypoint: byte-identical.
- ESM entrypoint SHA-256: `29239d69a595553c2bafda10b517ddf3722c3f32e044353d8e8ea629de1e9854`.
- Core tarball SHA-256: `dd97bfc4d31d7caf9b80a46bb4e1d244610e0780a3ba6b551f19f4dd21eb7ef1`.

`scripts/verify-uifn-core-reproducible.mjs` deletes and rebuilds the complete core distribution twice in isolated captures. Both directory hashes are:

`ed4c5a6c3c834169db559f941093e8d36bc7ae5027f9cd921775172446f9fdd6`

Multi-entry tsup splitting was disabled because it produced alternating content-equivalent chunk names between identical builds. The resulting unsplit multi-entry output is byte-reproducible and keeps public entrypoints stable.

The Node import matrix passes on Node 20, 22, and 24 while `document` and `window` throw on read. It exercises one deterministic static contract and an interactive Toast controller, proving that the public core entrypoint remains DOM-free.

## Verification

### Authoritative phase gate

`npm run verify:uifn-phase-06` — **PASS**

The successful final run includes:

1. `@uifn/core` typecheck, 36 test files / 149 tests, and build;
2. Phase 06 positive and exact controlled-negative contract tests;
3. generated Phase 06 export/type/test-manifest drift check;
4. two-build core distribution reproducibility;
5. real core package/source consumer execution;
6. inherited controller and one-private-runtime gates;
7. adapter-kit, React, Svelte, and Solid typechecks;
8. canonical 61-primitive catalog generation drift check;
9. full stable aggregate, including governance, Node 20/22/24, clean consumers, and pack hygiene.

Focused results:

- `npm --workspace @uifn/core run test` — **PASS**, 36 files / 149 tests.
- `node --test scripts/verify-uifn-phase-06-contract.test.mjs` — **PASS**, 3/3.
- `node scripts/verify-uifn-phase-06-contract.mjs --require-dist` — **PASS**, 14 primitives, 9 algorithm capabilities, 9 static contracts, 5 controllers, zero issues.
- `node scripts/generate-uifn-phase-06.mjs --check` — **PASS**, 3 generated outputs, zero drift.
- `node scripts/verify-uifn-core-reproducible.mjs` — **PASS**, identical directory hashes.
- `node scripts/verify-uifn-foundation-pack.mjs` — **PASS**, package `42`, source `42`, byte-identical entrypoint.
- `node scripts/verify-uifn-core-node-matrix.mjs` — **PASS**, Node 20/22/24.
- `npm run verify:uifn-governance` — **PASS**, all 10 checks; Phase 06 gate ownership recorded.
- React, Svelte, and Solid typechecks — **PASS**.
- `git diff --check` — **PASS**.

The Vite CJS Node API deprecation warning remains toolchain noise from the existing Vitest stack; it does not suppress or downgrade a test failure.

## Generated and public surfaces

The phase adds deterministic generated artifacts:

- `uifn/core/generated/phase-06-exports.json`
- `uifn/core/generated/phase-06-test-manifest.json`
- `uifn/core/generated/phase-06-types.d.ts`

`@uifn/core` now publishes the generated folder and a public `@uifn/core/algorithms` entrypoint with package export and TypeScript resolution coverage. The generator's `--check` mode fails if source-of-truth output and committed files diverge.

The root `verify:uifn-phase-06` surface is owned by `uifn-maintainer` with a seven-day review cadence. This was required because governance discovers every root `verify:uifn-*` command and fails closed on unowned release gates.

## Files and surfaces changed

### Canonical algorithm layer

- `uifn/core/src/algorithms/async-list.ts`
- `uifn/core/src/algorithms/collection.ts`
- `uifn/core/src/algorithms/id.ts`
- `uifn/core/src/algorithms/locale.ts`
- `uifn/core/src/algorithms/navigation.ts`
- `uifn/core/src/algorithms/range.ts`
- `uifn/core/src/algorithms/selection.ts`
- `uifn/core/src/algorithms/typeahead.ts`
- `uifn/core/src/algorithms/virtualization.ts`
- public algorithm index/root/package exports.

### Foundational primitives

- New static-contract substrate and Button, Field, Fieldset, Form, Input, Marquee, and QRCode contracts.
- Avatar and Separator converted to static contracts.
- New ImageCropper controller.
- Accordion, Collapsible, ScrollArea, and Toolbar semantic/behavior upgrades.
- Select, Combobox, Slider, shared helpers, ID helpers, and roving focus migrated to canonical algorithms.

### Verification and packaging

- Phase 06 algorithm and primitive test suites.
- Phase 06 generator, contract verifier, mutation tests, reproducibility verifier, package/source verifier, and aggregate gate.
- Core `generated` package contents, `algorithms` entrypoint, and deterministic tsup configuration.
- Node import smoke and runtime benchmark migrated away from the removed Avatar controller.
- Governance ownership entry for `verify:uifn-phase-06`.

### Framework boundary corrections

- React generic Avatar/Separator controller hooks removed.
- Svelte Avatar image status uses rendering-local state rather than a static-core controller.
- Solid generic Avatar/Separator controller factories removed.
- Adapter-kit controller conformance no longer treats Avatar/Separator as interactive.

## Remaining adapter and release work

Phase 06 deliberately does not add polished compound adapters or styled components early.

- Phase 11 must implement and validate React components for these core contracts.
- Phase 12 must implement and validate Svelte components.
- Phase 13 must implement and validate Solid components.
- Those phases must render the static anatomy, map public controller parts, preserve handler order/ref composition, and add framework-native controlled/reactive/SSR/hydration proof.
- Phase 14 owns real-browser cross-framework integration and mobile/touch matrices.
- Phases 18 and 19 own automated accessibility hardening, VoiceOver/NVDA/TalkBack evidence, and independent review. JAWS remains explicitly deferred by program decision.
- Phase 20 owns immutable release-candidate evidence and the final 10/10 claim.

The catalog-wide generated release matrix continues to distinguish core evidence from not-yet-implemented framework outputs. Phase 06 completion must not be used to mark the 61-primitive ecosystem release-ready.

## Rollback and operational notes

- Consumers migrating from temporary `createAvatarController` or `createSeparatorController` APIs must use `AvatarContract` or `SeparatorContract`; the migration inventory records those replacements.
- Static contracts are intentionally pure. Image load events, DOM effects, timers, and actual rendering belong to adapters or owned DOM services, not core.
- Duplicate keys now fail closed. Consumers that previously depended on last-write-wins Select/Combobox behavior must provide stable unique keys.
- Re-enabling tsup entry splitting requires a reproducible chunk-naming proof; otherwise the Phase 06 gate will fail the two-build directory hash.
- No commit, push, publication, or external state change was performed.
- The phase is not final, so `uifn/.conduct/tracker.csv` was intentionally not advanced. Final tracker closure remains Phase 20 work.

## Handoff to Phase 07

Overlay and modal primitives should consume the canonical IDs and any applicable collection/range helpers from this phase, plus the Phase 05 DOM layer. They must not create local typeahead, selection, key traversal, ID, outside-interaction, focus-scope, positioning, portal, presence, modal-isolation, or scroll-lock implementations.

Phase 07 can assume:

- deterministic IDs and public part contracts are stable;
- core controller/runtime invariants still pass;
- the shared DOM platform remains the sole DOM behavior layer;
- static primitives do not establish a precedent for unnecessary controllers;
- package/source and stable gates will fail on reintroduced forks or lost native semantics.

## Is the next phase unblocked?

**Yes.** The shared algorithm layer and all 14 Phase 06 foundational primitive contracts pass their phase and inherited stable gates. Phase 07 can begin.

## Blockers

None for Phase 07 entry. The overall 1.0 readiness program remains open through Phase 20 and must not yet be represented as production maturity 10/10 or accessibility confidence 10/10.
