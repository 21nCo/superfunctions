# PHASE_11 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T15:12:37Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin 25.4.0 arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the phase; user and earlier-phase changes were preserved |
| Phase definition hash | `7775e458d72253b302e781fdb063b56122d1aacb503335988c43f99caedcd203` |
| Lockfile hash | `22713c087ada8e7eff8d92ee35c1f371db6b3036fe9cf90a81422c02c14685c3` |
| Evidence root | `.conduct/evidence/phase-11/2026-07-18T2025+0530-PHASE-11-b7c4e2a1/` |

## Phase

- Phase: `PHASE_11`
- Status: **PASS**
- Requirement delivered: `REACT-001`
- Vectors delivered: `TV-REACT-001-P`, `TV-REACT-001-N`
- Objective: complete the public React compound system for all 61 stable catalog primitives while keeping behavior in `@uifn/core` and browser ownership in `@uifn/dom`.

## Outcome

`@uifn/react` now exposes one concrete, typed compound for every stable catalog primitive. The generated inventory covers 61 roots and all 419 catalog anatomy parts. Every primitive publishes a root/provider, a typed component for each anatomy part, a typed `use<Name>` controller hook, and an object-style compound API such as `Dialog.Root`, `Dialog.Trigger`, and `Dialog.Content`. The source and built inventories match the catalog exactly.

React is a rendering and lifecycle adapter, not a second behavior engine. Interactive compounds create public core controllers, subscribe through `useSyncExternalStore`, project public part props, and attach public DOM services to mounted elements. Static primitives project their typed core contracts. Controller actions, controlled inputs, callbacks, IDs, semantic state, keyboard policy, focus policy, selection, positioning, layers, gestures, form values, and timers remain owned below React.

The adapter supports React 18.3.1 and React 19.2.3. It passes StrictMode, concurrent transitions, Suspense, deterministic and streaming server rendering, hydration, portal hydration, native form reset, abrupt unmount, and error-boundary cleanup with zero captured React, hydration, recoverable, or application console warnings.

The authoritative Phase 11 gate passes 20/20 checks. The durable browser result passes 3/3 projects with traces for Chromium, Firefox, and WebKit. The repository-wide stable gate also passes after repeating the complete 44-test browser matrix and all stable package, consumer, architecture, governance, and pack checks.

This is the complete React adapter milestone, not the final ecosystem 10/10 release verdict. Svelte, Solid, cross-framework parity, styled packages, registry delivery, docs, automated and manual accessibility certification, independent review, performance, security, and immutable release proof remain owned by Phases 12–20.

## Public API and type snapshot

For each catalog primitive named `Name`, generation now emits:

- `NameRoot` and `NameProvider`;
- one `Name<Part>` component for every catalog anatomy part;
- `NameRootProps` and one typed prop type per anatomy component;
- `useName(inputs)` returning typed public state, actions, status, and part access;
- `Name`, an object compound containing `Provider`, `Root`, and every anatomy member;
- a root export and a direct `@uifn/react/<primitive-id>` export.

Root props combine the public core input contract, native element props, `environment`, children, `asChild`, and `render`. Part props are derived from the corresponding controller part type and native element type; repeated anatomy parts require their typed `value`. Refs are forwarded to the actual rendered element.

The package peer contract is exact for this phase:

- `react: >=18.3.0 <20`
- `react-dom: >=18.3.0 <20`
- Node `>=20 <25`

The root and all 61 direct built entries retain an explicit `'use client'` directive. Direct subpaths are independently emitted and verified for consumer tree shaking. The top-level module can be imported with no DOM globals during server/RSC evaluation.

## Composition semantics

`asChild` and `render` preserve the consumer's intrinsic element, accessible name, native semantics, `href`, form behavior, disabled policy, class/style, and ref. User handlers run before primitive handlers, and `preventDefault()` cancels the primitive handler. Generated required semantic and state props remain authoritative after user-prop merging.

The slot implementation composes React 18 element refs and React 19 ref props without reading a deprecated element-ref field. A composition target that does not forward the required part ref fails with exact code `UIFN_PART_REF_LOST`; it is not silently accepted.

Portals remain React-rendered so hydration and reconciliation stay framework-correct. `@uifn/dom` receives `portalManagedExternally: true` and still owns layering, focus scope, modal isolation, dismissal, positioning, and presence services. `Presence` and `Portal` retain only framework mount/readiness state, which is a justified rendering synchronization exception rather than domain behavior.

## Behavior and DOM ownership

The shared React bridge:

- uses `useSyncExternalStore` for client and server snapshots;
- builds a deterministic inert preview controller for SSR, then activates the live public controller when subscribed;
- proxies callback inputs so live controllers always call the latest React callback without behavior duplication;
- calls the public controller `update()` path for controlled input changes;
- destroys the controller synchronously when its final subscriber unmounts;
- registers actual anatomy elements by ref and binds them to `@uifn/dom` services;
- uses the overlay, menu, navigation-menu, roving-focus, range-gesture, and native-form-reset bindings;
- renders static contracts through the same public part projection path.

Retired local React hooks for controllable state, roving focus, focus trapping, outside interaction, positioning, body locking, Escape handling, and primitive-specific behavior were removed. The DOM ownership verifier now names the canonical React compound bridge rather than those deleted hooks. The Phase 11 verifier fails closed if any retired local behavior hook is restored.

No React selection engine, keyboard engine, focus manager, layer stack, positioning algorithm, or primitive timer was added. Legacy component filenames that remain for source migration are one-line re-exports of generated compounds, not alternate implementations. Removed non-catalog and retired APIs have no compatibility shim.

## Core and DOM contract corrections discovered by exhaustive mounting

The exhaustive React inventory exposed a small set of canonical-contract gaps that had to be corrected at their owning layers:

- Switch now exposes exact `root`, `control`, `thumb`, `label`, and `hiddenInput` anatomy, including hidden native form behavior.
- Toolbar now exposes exact `root`, `button`, `link`, `toggleGroup`, and `separator` anatomy; adapter conformance uses those public parts.
- Accordion exposes its indicator and ScrollArea exposes content through the canonical controller.
- ColorPicker channel inputs and ImageCropper zoom controls dispatch to their canonical controller actions.
- selected indicators use canonical hidden-state projection, and RatingGroup items retain native button semantics.
- the DOM package exposes public native-form-reset and range-gesture bindings for React element ownership.
- overlay and navigation DOM services accept external portal placement without surrendering service ownership.

These are owning-layer fixes, not React workarounds. Core tests, adapter conformance, the contract verifier, and browser traces cover them.

## React lifecycle and consumer proof

| Surface | Exact runtime | Proof |
| --- | --- | --- |
| Source consumer | React 18.3.1 | Vitest imports the source root, mounts all 61 compounds and 419 anatomy components in StrictMode, checks refs/composition/forms, and captures zero warnings. |
| Workspace build consumer | React 18.3.1 | Built root imports without DOM globals; deterministic SSR, streaming Suspense, hydration, and abrupt unmount pass with zero warnings. |
| Clean packed consumer | React 19.2.3 | A temporary consumer installs the packed tarball plus exact React versions and mounts all 61 public compounds through separate server/client realms. |
| Direct subpath consumer | React 19.2.3 | Direct generated subpath import resolves, retains the client boundary, and proves tree-shakeable delivery. |
| Real browsers | React 18.3.1 package build | Chromium, Firefox, and WebKit exercise controller state, portal placement/dismissal, actual pointer movement, native hidden input/reset, unmount, and warning capture. |

React 19 clean-consumer assertions cover StrictMode, transitions, Suspense, deterministic IDs, streaming SSR, hydration, portal hydration, form reset, error-boundary cleanup, abrupt unmount, and zero warnings. Separate server and client subprocesses prevent a false multi-renderer result and model real realm separation.

## Controlled-negative evidence

| Mutation | Required classification | Result |
| --- | --- | --- |
| React adds local selection state | `UIFN_FRAMEWORK_BEHAVIOR_FORK` | killed |
| React adds local keyboard/focus behavior | `UIFN_FRAMEWORK_BEHAVIOR_FORK` | killed |
| Required anatomy ref is not forwarded | `UIFN_PART_REF_LOST` | killed |
| Generated compound omits catalog anatomy | `UIFN_ADAPTER_COVERAGE_MISSING` | rejected |
| Generic exported factory substitutes for a required compound | `UIFN_FRAMEWORK_BEHAVIOR_FORK` | rejected |
| Direct built entry loses its client boundary | `UIFN_ERR_EXPORT_SURFACE_MISMATCH` | rejected |
| React peer range excludes a required runtime | `UIFN_ERR_UNSUPPORTED_ENVIRONMENT` | rejected |
| Retired local React behavior hook returns | `UIFN_FRAMEWORK_BEHAVIOR_FORK` | rejected |

Exact codes are asserted by mutation tests and the canonical error registry. Generic process failure is not accepted as negative-vector proof.

## Browser evidence

Durable JSON: `.conduct/evidence/phase-11/2026-07-18T2025+0530-PHASE-11-b7c4e2a1/browser/results.json`

| Project | Tests | Result | Trace |
| --- | ---: | --- | --- |
| Chromium | 1 | PASS | `browser/artifacts/...-chromium/trace.zip` |
| Firefox | 1 | PASS | `browser/artifacts/...-firefox/trace.zip` |
| WebKit | 1 | PASS | `browser/artifacts/...-webkit/trace.zip` |

The JSON report records `expected: 3`, `unexpected: 0`, and `skipped: 0`. Each project has zero Playwright errors and contains both a structured `phase-11-react-result` attachment and a trace. The structured attachments record successful Accordion state, Slider pointer output, Dialog closure, body-level portal placement, RatingGroup form/reset behavior, and an empty warning list.

The repository stable gate separately passes 44/44 browser tests: all preceding DOM/primitive cases plus the Phase 11 React case in each desktop engine and the applicable mobile-emulation matrix.

## Generated and release-contract proof

`scripts/generate-uifn-phase-11.mjs` emits the 61 concrete compound sources, the generated source index, and `uifn/react/generated/phase-11-react-compounds.json`. Check mode is byte-identical and reports exactly 61 primitives.

The Phase 11 contract verifier compares the source manifest with the generated catalog, checks every generated component and hook symbol, rejects generic compound factories, audits behavior ownership and removed legacy hooks, validates peer ranges and subpath exports, imports built core and React output, constructs every core controller/static contract, compares anatomy order exactly, verifies every built compound member, and verifies every direct client entry.

The build preserves client boundaries in root and direct CJS/ESM output while keeping source maps valid. Declaration emission excludes tests and setup files. The pack verifier reports 703 React tarball files and no test, fixture, story, conduct, cache, tool-config, environment, or log path leak.

`verify:uifn-phase-11` is registered in the governance ownership ledger with the standard seven-day review cadence.

## Verification summary

### Authoritative Phase 11 gate

`npm run verify:uifn-phase-11` — **PASS**, 20/20 checks, durable result at `.conduct/evidence/phase-11/2026-07-18T2025+0530-PHASE-11-b7c4e2a1/results.json`.

1. Phase 11 generation check — PASS, 61 compounds.
2. Core typecheck — PASS.
3. Core tests — PASS, 30 files / 156 tests.
4. Core build — PASS.
5. DOM typecheck — PASS.
6. DOM tests — PASS, 1 file / 1 test.
7. DOM build — PASS.
8. Adapter-kit typecheck — PASS.
9. Adapter-kit tests — PASS, 4 files / 16 tests.
10. Adapter-kit build — PASS.
11. React typecheck — PASS.
12. React tests — PASS, 9 files / 20 tests.
13. React build — PASS.
14. Focused Phase 11 React contract — PASS, 5/5 tests.
15. React 18.3.1 built-workspace runtime — PASS, zero warnings.
16. React 19.2.3 clean packed consumer — PASS, all 61 compounds, zero warnings.
17. Phase 11 mutation classifier — PASS.
18. Built Phase 11 contract verifier — PASS, zero issues.
19. Chromium/Firefox/WebKit browser matrix — PASS, 3/3 with traces.
20. Stable package pack verifier — PASS, no forbidden paths.

### Additional regression gates

- `npm run verify:uifn-stable` — PASS across 24 stable checks, including governance, source cleanliness, package graph, catalog determinism, core/DOM builds and tests, React/Svelte/Solid typechecks, architecture, Node 20/22/24, clean consumers, pack hygiene, and 44/44 browser tests.
- `node scripts/verify-uifn-dom-platform.mjs` — PASS, 257 production framework files and zero ownership violations.
- DOM platform positive/negative tests — PASS, 2/2.
- Governance verifier — PASS, 10/10 checks and 37 owned release gates.
- `git diff --check` — PASS before report creation and required again after the artifact/log write.
- Phase-scoped debt scan — no deferred-work marker.

No failing result was skipped, marked flaky, converted to a dry run, or accepted as a test-environment limitation.

## Deliverables summary

### Added

- The shared React compound bridge and public prop projection path.
- Sixty-one concrete generated React compound modules and their exact manifest.
- Exhaustive React source, React 18 runtime, React 19 packed-consumer, mutation, browser, and aggregate verification.
- Public DOM form-reset and range-gesture bindings required by mounted React parts.
- Durable Phase 11 JSON results and three browser traces.

### Modified

- React root exports, package peer/export contracts, build/client-boundary preservation, declaration scope, Slot/ref semantics, Portal/Presence rendering, and core-prop event projection.
- Core anatomy/action/native semantics discovered through exhaustive public-tree mounting.
- Adapter-kit Switch/Toolbar conformance vectors.
- DOM overlay/navigation external-portal integration and ownership verification.
- Root verification scripts and governance ownership.

### Removed or retired

- Legacy React behavior implementations and obsolete tests tied to retired APIs.
- Non-catalog React components and old compatibility names with no canonical compound.
- Dead local React controllable-state, roving-focus, focus/layer/position, dismissal, and primitive-specific hook paths.
- Test/setup declarations from the published tarball.

Obsolete tests were not dropped without replacement: the exhaustive 61-compound/419-part source suite, clean React 19 consumer, real-browser matrix, mutation gates, and exact built-contract verifier replace their legacy implementation-specific coverage.

## Notes and limitations

- Browser projects are desktop engines; the full stable suite additionally covers applicable mobile emulation. Physical-device certification remains later work.
- React package completion does not establish Svelte/Solid parity; Phases 12–14 own those claims.
- Axe, forced-colors, zoom/reflow, VoiceOver, NVDA, TalkBack, and independent accessibility review remain assigned to Phases 18–19. JAWS is intentionally outside the current agreed matrix.
- Performance budgets, heap proofs, SBOM/signing/provenance, registry rollback, and immutable release-candidate verification remain assigned to later phases.
- No commit, push, publication, or external state change was performed.
- The phase is not final; `.conduct/tracker.csv` was intentionally not advanced. The final spec phase remains Phase 20.

## Rollback notes

Rollback is scoped to the Phase 11 React bridge/generated surface, direct-entry build configuration, Phase 11 verifiers/evidence, DOM form/gesture and external-portal integration, and the small canonical core anatomy corrections above. Do not restore the retired local React behavior implementations or compatibility shims; if rollback is required, restore the preceding Phase 10 catalog/core state and keep React unpublished until a replacement adapter passes the same vectors.

## Ready for next phase?

**Yes.** Phase 12 can implement Svelte against the same frozen 61-primitive public controller, anatomy, and DOM-service contracts.

## Blockers

None for Phase 12. The overall 10/10 program remains incomplete until Phases 12–20 pass.
