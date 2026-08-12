# PHASE_05 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T09:06:27Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the phase; user and earlier-phase changes were preserved |
| Phase definition hash | `8730a9b359ea438fb5c0ef4e07ed98f5377fe59e2e891ac2c4b7ce274e27ff71` |
| Lockfile hash | `9a78346e07fc1dcc9418d2adb7172ceb81c0dde7cbac9112045f8d3a9d85b6c7` |
| Evidence | `uifn/.conduct/evidence/phase-05/2026-07-18T090627Z-PHASE-05-818edec2.json` |

## Phase

- Phase: `PHASE_05`
- Status: **PASS**
- Requirements delivered: `DOM-001`, `DOM-002`, `DOM-003`, `DOM-004`, `DOM-005`, `DOM-006`, `DOM-007`
- Objective: make `@uifn/dom` the sole production DOM behavior layer used by framework adapters, with real-browser proof and deterministic teardown.

## Outcome

`@uifn/dom` is now a real framework-neutral package instead of a placeholder. It owns root scoping, delegated listeners, resource accounting, modality, tabbability, dismissable layers, focus scopes, modal isolation and scroll locking, positioning, portals, presence, form bridges, live regions, and pointer tracking. Every service consumes the explicit Phase 04 environment rather than discovering ambient process state.

React and Svelte production code now binds these services through thin framework lifecycle adapters. The static ownership gate scanned 212 production framework files and found no rejected local root listener, outside-interaction classifier, focus trap, floating-position algorithm, scroll lock, portal mover, or presence observer. Solid currently contains no competing DOM implementation and typechecks against the stable graph.

The full positive and controlled-negative DOM corpus ran in Chromium, Firefox, and WebKit. All 21 browser cases passed and produced one screenshot and one Playwright trace each. The stress fixture mounted, interacted with, destroyed, and abruptly removed service consumers, then proved zero remaining listeners, observers, timers, animation frames, layers, focus scopes, modal locks, positioners, portals, presence jobs, form bridges, live regions, and modality resources.

This is development-phase evidence from a dirty worktree, not immutable release-candidate evidence. Physical iOS/Android browser and assistive-technology confirmation remains assigned to Phases 14, 18, and 19.

## Stable DOM service interfaces

### Scope and shared platform

- `createUIFnDomScope({ root, environment, traceLimit })` accepts a `Document`, open `ShadowRoot`, or `HTMLElement` root and resolves its owner document/window without cross-root global lookup.
- `scope.on()` delegates one native listener per root/type/options tuple while allowing multiple service callbacks. Listener removal is exact and reference-free when the last callback leaves.
- `scope.track()`, `setTimeout()`, `requestAnimationFrame()`, and observer helpers maintain a typed resource ledger and bounded diagnostic trace.
- `createUIFnDomPlatform()` lazily constructs services. `acquireUIFnDomPlatform()` shares one platform per root and destroys it when the final lease is released.
- Every mutable service rejects post-destroy operations with stable `UIFN_DOM_SERVICE_DESTROYED`; invalid roots and missing required DOM objects use `UIFN_DOM_SCOPE_INVALID`.

### Focusability and input modality

- `getUIFnTabbableElements()` and `isUIFnFocusable()` wrap the reviewed `tabbable` implementation behind owned contracts.
- Discovery handles disabled/inert/hidden content, radio groups, details, contenteditable, explicit tabindex, iframes, and open shadow roots.
- Layoutless test environments use an explicit zero-layout fallback; real browsers retain visibility/layout checks.
- `createUIFnInputModality()` tracks keyboard versus pointer modality with one shared root listener set and exposes focus-visible policy without adapter-local listeners.

### Dismissable layers

- `createUIFnDismissableLayerStack()` routes pointer-outside, focus-outside, and Escape only to the top eligible layer.
- Branches preserve logical containment for portals and open shadow content through composed paths.
- Pointer capture, right-click and control-click policy, touch completion/cancellation, scrollbar interactions, cancellation, and layer reordering are centralized.
- Outside and Escape callbacks receive cancellable owned interaction records before dismissal.

### Focus scopes

- `createUIFnFocusScopeManager()` supports nested scopes, parent pause/resume, forward/backward loop, autofocus cancellation, delayed work cancellation, and deterministic restore/fallback.
- A child close resolves the paused parent before restoration, avoiding body-focus gaps.
- Temporary focusability added for programmatic focus is removed exactly during teardown.

### Modal isolation and scroll locking

- `createUIFnModalManager()` owns nested inert/`aria-hidden`/pointer isolation and snapshots every changed attribute/style for exact restoration.
- Scroll locks are nested, compensated, and target-aware. Desktop overflow locks do not perform unnecessary scroll restoration.
- The iOS path uses fixed-body offsets, touch arbitration, optional pinch zoom, `visualViewport` resize/scroll synchronization, and scroll-position restoration.
- Abrupt unmount releases isolation, touch/viewport listeners, scroll styles, and resource counters.

### Positioning

- `createUIFnPositioner()` privately wraps Floating UI `computePosition`/`autoUpdate` behind UIFn-owned placement, middleware, result, trace, and lifecycle types.
- Owned options cover side/alignment offsets, flip, shift, sticky behavior, clipping boundaries, size, arrow, hide, inline references, fixed/absolute strategy, virtual anchors, and animation-frame updates.
- Results expose stable CSS custom properties rather than Floating UI middleware objects.
- Auto-update teardown is tracked as an observer resource and stale async results cannot publish after destruction.
- Layoutless environments disable collision middleware that cannot have meaningful viewport geometry; real browser geometry remains authoritative.

### Portal and presence

- `resolveUIFnPortalTarget()` resolves targets relative to an injected scope or root, including shadow roots and selector targets.
- `createUIFnPortal()` moves/restores nodes transactionally, registers logical branches, rejects duplicate hydration nodes, supports disabled/update paths, and rolls back failed mounts.
- The React portal adapter renders an SSR/hydration-stable inline first pass and then transfers ownership to the resolved portal target, ensuring parent layout effects bind the actual node lifecycle.
- Svelte portal teardown removes component-owned portal nodes rather than restoring zombie nodes after Svelte unmount.
- `createUIFnPresence()` owns enter, present, exit, interruption, animation/transition completion, cancellation, timeout fallback, force-mount, and reduced-motion completion.

### Form bridges and live regions

- `createUIFnFormBridge()` uses native visually-hidden text inputs so controller values participate in `FormData`, validation, reset, required/disabled/readonly state, labels, descriptions, and disabled fieldsets.
- Duplicate same-name bridge ownership is rejected and every native listener/input is removed on teardown.
- `createUIFnLiveRegion()` centralizes polite/assertive regions, ordering, locale-ready message input, deduplication, stale-message rejection, and cleanup.
- Duplicate regions, stale announcements, and post-destroy work have stable diagnostics.

## Dependency review and boundary

| Dependency | Use | Boundary decision |
| --- | --- | --- |
| `@floating-ui/dom` `1.8.0` | geometry and observer primitives | Private implementation detail behind `createUIFnPositioner`; no dependency middleware/result type is exported. |
| `tabbable` `6.5.0` | browser-tested focusability/tab order | Private implementation detail behind UIFn focus APIs; adapters cannot import it directly. |
| Playwright `1.57.0` | Chromium/Firefox/WebKit development evidence | Dev-only test dependency; absent from runtime exports. |

Both runtime dependencies are MIT-licensed. The focused rationale, ownership, alternatives, and wrapper rules are recorded in `uifn/dom/DEPENDENCIES.md`. `@uifn/dom` declares `sideEffects: false`, emits ESM/CJS/declarations/source maps, and exposes only its owned root entrypoint.

## Framework integration

### React

- Scroll locking, Escape routing, focus trapping, outside interaction, positioning, portals, presence, and pointer tracking bind `@uifn/dom`.
- Trigger/content branches preserve portal containment.
- Point anchors drive context-menu placement through the shared positioner.
- SSR/hydration remains warning-free while first-mount hooks receive a concrete content node.
- Full React regression: 28 files and 73 tests passed.

### Svelte

- Actions in `src/internal` bind shared scroll, focus, dismissal, portal, and position services.
- Dialog, menu, combobox, popover, context-menu, tooltip, and scroll-area content use those actions rather than local root behavior.
- The focused migrated-DOM regression set passed 6 files and 7 tests.

### Solid

- No Phase 05-equivalent local DOM behavior was present to migrate.
- Package typecheck passes against the stable graph; complete adapter semantics remain owned by Phase 13.

## Requirement and vector evidence

| Requirement | Positive evidence | Controlled negative evidence | Status |
| --- | --- | --- | --- |
| `DOM-001` | tabbable/modality matrix across document, iframe, open shadow, observer lifecycle, one root listener set | inert tabbable and duplicate listener seeds emit `UIFN_TABBABLE_INVALID` / `UIFN_ROOT_LISTENER_DUPLICATE` | PASS |
| `DOM-002` | nested portaled/branched layers route pointer, focus, Escape, touch, right click, and cancellation to the top eligible layer | local `contains` classifier seed emits `UIFN_LAYER_OUTSIDE_CLASSIFICATION` | PASS |
| `DOM-003` | nested focus scopes loop, pause/resume, cancel autofocus, repair removed restore targets, and tear down guards | guard/restore mutations emit `UIFN_FOCUS_SCOPE_ESCAPE` / `UIFN_FOCUS_RESTORE_FAILED` | PASS |
| `DOM-004` | nested desktop/iOS-simulated modal isolation, viewport updates, abrupt unmount, and exact state restoration | early unlock/stale isolation seeds emit `UIFN_SCROLL_LOCK_NESTING` / `UIFN_MODAL_ISOLATION_STALE` | PASS |
| `DOM-005` | edges, clipping, transforms, fixed context, zoom, RTL, point anchors, resize/scroll auto-update, and observer cleanup | boundary/leaked observer seeds emit `UIFN_POSITION_OUT_OF_BOUNDARY` / `UIFN_POSITION_OBSERVER_LEAK` | PASS |
| `DOM-006` | SSR-safe target resolution, document/shadow portals, enter/exit/reopen/cancel/reduced-motion/force-mount lifecycle | duplicate portal seed emits `UIFN_PORTAL_HYDRATION_DUPLICATE`; interrupted presence resolves without leak | PASS |
| `DOM-007` | native `FormData`/reset/validation/fieldset behavior plus ordered polite/assertive announcements and teardown | duplicate bridges/stale announcements emit `UIFN_FORM_BRIDGE_DUPLICATE` / `UIFN_LIVE_REGION_STALE_MESSAGE` | PASS |

Each row ran in Chromium `143.0.7499.4`, Firefox `144.0.2`, and WebKit `26.0`. The Playwright JSON result contains 21 expected, zero unexpected, zero skipped, and zero flaky tests. Raw evidence is under `uifn/.conduct/evidence/phase-05/browser/` and occupies approximately 3.8 MB.

## Verification

### Authoritative phase gate

`npm run verify:uifn-phase-05` — **PASS**

The gate performed:

1. static ownership verifier tests;
2. controlled negative source fixtures with exact error codes;
3. actual `npm pack` for `@uifn/core` and `@uifn/dom`;
4. clean temporary consumer install and public import;
5. the complete stable gate, including governance, package graph, core/DOM checks, framework typechecks, consumers, pack integrity, and the 21-case real-browser matrix.

### Browser corpus

`npm run test:browser --workspace @uifn/dom` — **PASS**, 21/21.

- Chromium: 7/7.
- Firefox: 7/7.
- WebKit: 7/7.
- Screenshots: 21.
- Traces: 21.
- Results hash: `6a8e8a6d95b6248e5726f474895b7cf66a92b64766c90d17a5132dce74631264`.
- Artifact-tree hash: `899aae00e0ffd51c62457d58d774b4453636884c5930808e3080120ee59a8521`.

### Static and mutation ownership

- `node --test scripts/verify-uifn-dom-platform.test.mjs` — **PASS**, 2/2.
- `node scripts/verify-uifn-dom-platform.mjs` — **PASS**, 212 production files, zero violations.
- `node scripts/verify-uifn-dom-platform.mjs --fixture-negative` — **PASS**, all seven intended ownership codes observed.

### Package and consumer proof

- `node scripts/verify-uifn-dom-pack.mjs` — **PASS**.
- Core tarball: `6748add810f76efe2ed24ea6929625d8e86fffe025445b934b2ef7cb9558d13d`.
- DOM tarball: `82223430239c397b0d51902986eb5b2fbd4ec0adb36eb73234dd4ea2d7b75ad5`.
- Local and packed DOM ESM entrypoint: identical `21aa05236dbd6df2c0df9125192c7b0cc946ebc538083f6e9e7b11604f19480d`.
- Clean consumer imported `createUIFnDomScope`, `createUIFnDismissableLayerStack`, `createUIFnPositioner`, and `createUIFnFormBridge`.

### Framework regression checks

- `npm test --workspace @uifn/react` — **PASS**, 28 files / 73 tests.
- Focused Svelte DOM integrations — **PASS**, 6 files / 7 tests.
- React, Svelte, and Solid typechecks inside the stable gate — **PASS**.
- `npm run verify:uifn-governance` — **PASS**, including ownership of `verify:uifn-dom-platform`.
- `git diff --check` — **PASS**.

## Non-blocking findings outside Phase 05

The broad adapter runs were retained as diagnostic evidence but are not Phase 05 gates:

- Full Svelte currently has three pre-existing Phase 04 migration/reactivity failures: `AlertDialog.svelte` calls obsolete `machine.setOpen`, `Progress.svelte` calls obsolete `machine.setValue`, and `Collapsible.svelte` emits three Svelte state-snapshot warnings. These are controller-binding/public-adapter issues, not duplicated DOM behavior. They remain explicitly owned by the complete Svelte work in Phase 12.
- Full Solid has one stale assertion that invokes actions after owner disposal and expects them to remain callable. The frozen Phase 04 controller contract correctly throws `UIFN_CONTROLLER_DESTROYED`. Phase 13 owns updating the public Solid lifecycle contract and its tests.
- Browser logs contain no Phase 05 failures. Expected jsdom limitations such as canvas/pseudo-element diagnostics occur only in non-browser accessibility smoke tests and are not used as browser proof.

No unresolved defect blocks `DOM-001` through `DOM-007`. These findings must not be treated as a claim that adapter readiness is complete; Phases 11–14 remain mandatory.

## Files and surfaces changed

### New DOM package implementation

- `uifn/dom/src/scope.ts`
- `uifn/dom/src/focusable.ts`
- `uifn/dom/src/layers.ts`
- `uifn/dom/src/focus-scope.ts`
- `uifn/dom/src/modal.ts`
- `uifn/dom/src/positioning.ts`
- `uifn/dom/src/portal.ts`
- `uifn/dom/src/presence.ts`
- `uifn/dom/src/form.ts`
- `uifn/dom/src/live-region.ts`
- `uifn/dom/src/platform.ts`
- `uifn/dom/src/pointer.ts`
- `uifn/dom/src/index.ts`
- package configuration, README, dependency review, and unit test.

### Real-browser infrastructure

- `uifn/dom/browser/index.html`
- `uifn/dom/browser/harness.ts`
- `uifn/dom/browser/dom-platform.spec.ts`
- `uifn/dom/playwright.config.ts`
- screenshots, traces, and JSON results under `uifn/.conduct/evidence/phase-05/browser/`.

### Enforcement and release integration

- `scripts/verify-uifn-dom-platform.mjs`
- `scripts/verify-uifn-dom-platform.test.mjs`
- `scripts/verify-uifn-dom-pack.mjs`
- `scripts/verify-uifn-phase-05.mjs`
- root package scripts and stable gate integration.
- `uifn/.conduct/contracts/ownership.json` DOM services and release-gate ownership.

### Framework bindings

- React scroll/focus/Escape/outside/position/portal/presence/pointer helpers and affected overlay/scroll components.
- Svelte scroll/focus/dismiss/portal/position actions and affected overlay/scroll components.

## Rollback and operational notes

- The runtime dependency boundary is limited to `uifn/dom`; adapters depend on owned UIFn APIs, not Floating UI or `tabbable` directly.
- Removing `@uifn/dom` now requires reverting the adapter bindings and stable gate together; retaining local adapter fallbacks is intentionally forbidden.
- Every service exposes idempotent teardown and the shared platform releases only when the final root lease leaves.
- No commit, push, publication, or external state change was performed.
- The phase is not final, so `uifn/.conduct/tracker.csv` was intentionally not advanced. Final tracker closure remains Phase 20 work.

## Handoff to Phases 06–10

Primitive implementations must consume these stable services instead of implementing DOM behavior:

- Phase 06 foundations use scope, modality/tabbability, form bridges, live regions, and pointer/resource helpers.
- Phase 07 overlays use layers, focus scopes, modal isolation, positioning, portals, and presence with primitive-specific policies only.
- Phase 08 navigation uses shared layer/focus/position infrastructure while owning only menu/navigation semantics.
- Phase 09 selection/text primitives use form bridges, focus/modality, and live regions.
- Phase 10 gesture/feedback families use pointer tracking, positioning where applicable, presence, live regions, and explicit cleanup.

Adapter-owned selection, key maps, focus policy, outside classification, positioning policy, scroll locking, portal movement, presence observation, form serialization, or announcements remain prohibited.

## Is the next phase unblocked?

**Yes.** `@uifn/dom` now provides the owned, root-aware, teardown-safe behavior substrate required by the primitive family phases. Phase 06 can begin.

## Blockers

None for Phase 06 entry. The overall 1.0 readiness program remains open through Phase 20 and must not be represented as release-ready or accessibility 10/10 yet.
