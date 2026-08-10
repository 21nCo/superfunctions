# Requirements

This document is normative. `MUST` and `MUST NOT` are release-blocking. Each requirement has at least one positive and one negative vector in `TEST_VECTORS.md`; satisfying a requirement means passing every listed acceptance criterion and vector with current evidence.

## Scope and governance

### SCOPE-001 — Stable package graph

- Statement: The 1.0 program MUST ship the stable package graph defined in `SPEC.md`, with React, Svelte, and Solid as equal supported adapters and with dependency direction enforced.
- Rationale: The current graph couples reusable components to five framework packages and makes behavior ownership ambiguous (audit F-03, F-07, F-16).
- Acceptance:
  1. A machine-readable package graph lists every stable, private, and experimental workspace and its allowed dependencies.
  2. Stable packages have no edge to Vue, Angular, `patterns`, `sf`, example, Storybook, test, or product-demo code.
  3. CI rejects undeclared packages, cycles, forbidden edges, and missing public-entrypoint ownership.
- Vectors: `TV-SCOPE-001-P`, `TV-SCOPE-001-N`.

### CLEAN-001 — Remove Vue and Angular

- Statement: Vue and Angular packages, workbenches, generators, dependencies, scripts, exports, docs claims, fixtures, and release checks MUST be deleted without compatibility shims.
- Rationale: The user explicitly selected a three-framework product and authorized a breaking cleanup.
- Acceptance:
  1. Workspace, lockfile, packed-artifact, docs, generated inventory, and source-template scans contain no supported Vue/Angular surface.
  2. A migration note identifies the last compatible release and removal impact.
  3. Attempts to select `vue` or `angular` in the registry CLI fail with a stable unsupported-framework error.
- Vectors: `TV-CLEAN-001-P`, `TV-CLEAN-001-N`.

### EXP-001 — Experimental isolation

- Statement: `@uifn/patterns` and `@uifn/sf` MUST be separately versioned experimental products and MUST NOT block or be bundled into stable 1.0 packages or gates.
- Rationale: Current beta packages are release blockers despite not being part of the stable primitive contract (audit F-16).
- Acceptance:
  1. Their manifests, changelogs, release channels, docs, and gates say experimental.
  2. Stable verification can run and pass with both packages absent.
  3. Experimental failures are reported separately and cannot change the stable release result.
- Vectors: `TV-EXP-001-P`, `TV-EXP-001-N`.

### OPS-001 — Ownership and defect governance

- Statement: Every stable package, primitive family, DOM service, release gate, and accessibility matrix row MUST have an owner, review cadence, severity policy, and vulnerability/defect response target.
- Rationale: 10/10 maturity requires maintained operational ownership, not only passing code (audit F-01, F-16).
- Acceptance:
  1. `CODEOWNERS` and a machine-readable ownership ledger cover 100% of stable surfaces.
  2. P0/P1/P2 response and release-blocking rules are documented and exercised with a fixture.
  3. The 1.0 gate fails for expired evidence, unowned surfaces, open P0/P1 defects, or untriaged accessibility findings.
- Vectors: `TV-OPS-001-P`, `TV-OPS-001-N`.

## Core architecture

### ARCH-001 — One private runtime

- Statement: Every interactive stable primitive MUST execute on one private owned behavior/effect runtime inside `@uifn/core`; the runtime MUST NOT be a public general-purpose state-machine API.
- Rationale: Current generic machines, local stores, and hand-written controllers create competing semantics (audit F-02).
- Acceptance:
  1. Static analysis proves each interactive primitive imports the same private service constructor.
  2. No primitive owns an alternative queue, subscription store, transition engine, or effect lifecycle.
  3. Runtime internals are absent from package exports and packed declaration entrypoints.
- Vectors: `TV-ARCH-001-P`, `TV-ARCH-001-N`.

### ARCH-002 — Public controller contract

- Statement: Every stable interactive primitive MUST expose the uniform typed controller contract defined in `SPEC.md`: `status`, immutable `state`/`snapshot`, `actions`, typed `parts`, `update`, `subscribe`, and idempotent `destroy`.
- Rationale: The current facade lacks update/status/snapshot and has inconsistent lifecycle semantics (audit F-08).
- Acceptance:
  1. Contract tests compile and run for every interactive primitive.
  2. Subscriptions receive initial/current snapshots and every semantic change exactly once in documented queue order.
  3. `destroy` cleans resources, is idempotent, and subsequent mutation throws `UIFN_CONTROLLER_DESTROYED`.
- Vectors: `TV-ARCH-002-P`, `TV-ARCH-002-N`.

### ARCH-003 — No legacy behavior paths

- Statement: Legacy public `StateMachine`, controller adapters, primitive-local stores, and duplicate `createX` machine paths MUST be removed rather than shimmed.
- Rationale: Wrapping old behavior perpetuates the downgrade and makes parity unprovable (audit F-02, F-03).
- Acceptance:
  1. Export and source scans find no banned legacy identifiers or adapter wrappers.
  2. All repository consumers use controllers or framework compounds generated from the canonical definition.
  3. Migration documentation maps every removed API to its new API or states that no equivalent exists.
- Vectors: `TV-ARCH-003-P`, `TV-ARCH-003-N`.

### CORE-001 — Deterministic snapshots and event queue

- Statement: The runtime MUST process typed events through a synchronous, reentrancy-safe FIFO queue and publish immutable versioned snapshots for every semantic context, state, computed, status, or child-service change.
- Rationale: The current machine does not notify context-only same-state changes and exposes mutable semantics (audit F-02).
- Acceptance:
  1. Same-state context changes notify once with a new version; no-op events do not notify.
  2. Reentrant events are queued, not recursively interleaved; ordering is deterministic under repeated runs.
  3. Subscribers cannot mutate snapshots or corrupt later transitions.
- Vectors: `TV-CORE-001-P`, `TV-CORE-001-N`.

### CORE-002 — Reactive inputs, context, refs, computed state, and scope

- Statement: Services MUST support validated reactive inputs, immutable context updates, non-serializable refs, derived computed state, deterministic IDs, and an instance scope that prevents cross-root collisions.
- Rationale: These are baseline capabilities of a rigorous portable UI behavior layer and are absent or fragmented today (audit F-02, F-12).
- Acceptance:
  1. Updating controlled inputs recomputes dependent state/parts without service recreation.
  2. Refs never enter serializable snapshots; computed values update atomically with source context.
  3. Multiple roots/documents and SSR requests produce collision-free deterministic IDs with no shared mutable singleton state.
- Vectors: `TV-CORE-002-P`, `TV-CORE-002-N`.

### CORE-003 — Effects, activities, child services, and cleanup

- Statement: The runtime MUST own cancellable effects/activities, timers, observers, abort signals, and child services with deterministic enter/update/exit/destroy cleanup.
- Rationale: Framework-local effects currently create leaks and divergent behavior (audit F-02, F-03, F-14).
- Acceptance:
  1. Effect setup/cleanup order is traceable and exactly-once across transition, update, and destroy.
  2. Replaced async work is aborted and stale completions cannot mutate the service.
  3. Destroy recursively stops children, timers, observers, animation frames, listeners, and promises under runtime control.
- Vectors: `TV-CORE-003-P`, `TV-CORE-003-N`.

### CORE-004 — Typed metadata, errors, and traces

- Statement: Semantic changes MUST carry typed `ChangeMeta`, public failures MUST use stable error codes, and development/test builds MUST emit deterministic redacted semantic traces.
- Rationale: Current `meta?: unknown` and synthetic conformance obscure causes and regressions (audit F-05, F-08).
- Acceptance:
  1. Metadata identifies event/action/source/reason/previous and next versions without arbitrary unknown payloads.
  2. Error-code fixtures cover invalid input, invalid event, missing environment capability, and destroyed controllers.
  3. Trace comparison detects event, snapshot, callback, parts, DOM, focus, and cleanup divergence while redacting user content.
- Vectors: `TV-CORE-004-P`, `TV-CORE-004-N`.

### PART-001 — Typed parts and cancellable composition

- Statement: Each primitive MUST publish anatomy-specific typed part prop getters whose user handlers run first, can cancel generated behavior, and cannot override only explicitly declared semantic invariants.
- Rationale: Current generic parts run generated behavior first and overprotect arbitrary props (audit F-09).
- Acceptance:
  1. Part types expose correct element props, refs, `data-*`, ARIA relationships, and handler signatures.
  2. `preventDefault()` in a user handler prevents the generated action where documented.
  3. Invariant conflicts are deterministic and warn in development; safe class/style/ref/handler composition preserves both sides.
- Vectors: `TV-PART-001-P`, `TV-PART-001-N`.

### ENV-001 — Explicit environment contract

- Statement: Core and DOM behavior MUST use an injected environment/scope for document, window, root node, ID generation, direction, locale, timezone, clock, scheduler, observers, warnings, and feature detection; global browser reads MUST be isolated to default environment creation.
- Rationale: The current environment is too small for SSR, shadow roots, iframes, test determinism, and localization (audit F-04, F-13).
- Acceptance:
  1. Core imports no browser globals and runs in a Node SSR process.
  2. DOM services work against document, iframe, and open shadow-root fixtures via injected scope.
  3. Missing optional browser capabilities degrade or throw the specified stable error instead of crashing unpredictably.
- Vectors: `TV-ENV-001-P`, `TV-ENV-001-N`.

## DOM platform

### DOM-001 — Root scope, observers, modality, and tabbability

- Statement: `@uifn/dom` MUST own root-scoped event delegation, input-modality tracking, focus-visible behavior, tabbable/focusable discovery, and observer lifecycles across documents, iframes, and open shadow roots.
- Rationale: Current selectors and framework utilities miss hidden/inert/shadow/nested cases (audit F-04).
- Acceptance:
  1. Tabbability matches native behavior for hidden, disabled, inert, details, radio, contenteditable, tabindex, and shadow-root fixtures.
  2. Modality changes distinguish keyboard, pointer, touch, and programmatic focus without duplicate global listeners.
  3. All observer/listener resources are root-scoped and released at zero consumers.
- Vectors: `TV-DOM-001-P`, `TV-DOM-001-N`.

### DOM-002 — Dismissable layer stack

- Statement: `@uifn/dom` MUST implement a composed-path-aware dismissable-layer stack with nested layers, branches, pointer-outside, focus-outside, Escape routing, event cancellation, and top-layer precedence.
- Rationale: Current outside-click helpers use `contains` plus mouse/touch events and cannot model real overlay stacks (audit F-04).
- Acceptance:
  1. Only the correct top eligible layer receives outside/Escape dismissal.
  2. Portaled descendants, registered branches, shadow DOM, right-click, touch, pointer capture, and scrollbar interactions follow specified behavior.
  3. Cancellation at the outside/Escape hook prevents closing and is reflected in the semantic trace.
- Vectors: `TV-DOM-002-P`, `TV-DOM-002-N`.

### DOM-003 — Focus scopes

- Statement: `@uifn/dom` MUST provide nested focus scopes for initial focus, guards, loop/trap, autofocus cancellation, restore focus, removed-trigger fallback, and focus-race arbitration.
- Rationale: Reliable focus is a primary accessibility and production requirement not centrally implemented today (audit F-01, F-04, F-12).
- Acceptance:
  1. Keyboard traversal cannot escape a modal scope and can traverse a non-modal scope as specified.
  2. Nested close restores to the immediate parent trigger; removed/disabled triggers use a documented fallback.
  3. Concurrent open/close/unmount and delayed autofocus cases resolve deterministically without body-focus loss.
- Vectors: `TV-DOM-003-P`, `TV-DOM-003-N`.

### DOM-004 — Modal isolation and scroll locking

- Statement: `@uifn/dom` MUST coordinate modal aria isolation/inertness, pointer blocking, body/document scroll locking, scrollbar compensation, nesting, and restoration on desktop and mobile browsers.
- Rationale: Framework-local modal behavior risks stale attributes, scroll jumps, and nested-overlay failures (audit F-03, F-04).
- Acceptance:
  1. Background content is unavailable to focus, pointer, and accessibility tree while the top modal is active.
  2. Nested locks reference-count and restore exact prior inline attributes/styles after final close or abrupt unmount.
  3. iOS viewport/keyboard and desktop scrollbar fixtures do not jump or lose the prior scroll position beyond specified tolerance.
- Vectors: `TV-DOM-004-P`, `TV-DOM-004-N`.

### DOM-005 — Positioning and auto-update

- Statement: `@uifn/dom` MUST provide production positioning with placement, offset, flip, shift, arrow, size, hide, collision padding, boundary/clipping ancestors, RTL, transformed/fixed contexts, virtual anchors, and lifecycle-safe auto-update.
- Rationale: The current custom geometry only flips/clamps against a viewport (audit F-04).
- Acceptance:
  1. Geometry corpus passes viewport, scroll-container, transformed-parent, zoom, mobile visual viewport, RTL, and edge/corner cases.
  2. Position updates on relevant resize/scroll/layout/anchor changes without infinite loops or orphan observers.
  3. Arrow/available-size/hidden middleware data is exposed consistently to parts and CSS variables.
- Vectors: `TV-DOM-005-P`, `TV-DOM-005-N`.

### DOM-006 — Portal, presence, and transition lifecycle

- Statement: `@uifn/dom` MUST own root-aware portals and presence state that coordinates mount, enter, exit, animation completion/cancellation, reduced motion, force-mount, SSR, and cleanup.
- Rationale: Local portal/presence implementations cause adapter drift and race conditions (audit F-03, F-04).
- Acceptance:
  1. Portals target the injected document/root and preserve logical relationships for layers and focus.
  2. Exit content remains mounted only until the resolved transition ends; interruption and reduced-motion paths finish deterministically.
  3. SSR emits no DOM access and hydration does not duplicate portal or presence nodes.
- Vectors: `TV-DOM-006-P`, `TV-DOM-006-N`.

### DOM-007 — Form bridges and live regions

- Statement: `@uifn/dom` MUST provide native-form bridges and live-region services for names, values, reset, validation, disabled/readonly/required state, autofill where applicable, announcements, deduplication, and cleanup.
- Rationale: Form and feedback semantics currently vary by component and framework (audit F-03, F-12).
- Acceptance:
  1. Controller-backed widgets participate in `FormData`, submit, reset, constraint validation, labels/descriptions, and disabled fieldsets.
  2. Announcements have specified politeness, ordering, deduplication, locale text, and teardown.
  3. Duplicate hidden inputs/live regions and stale announcements are rejected by tests.
- Vectors: `TV-DOM-007-P`, `TV-DOM-007-N`.

## Catalog and primitive behavior

### CAT-001 — Canonical stable catalog

- Statement: One versioned canonical definition MUST enumerate the 61 GA primitives in `SPEC.md`, their anatomy, behavior family, inputs/events/states, accessibility rules, support state, docs, vectors, and generated outputs.
- Rationale: Current inventories and implementations can drift and only 25 core primitive names exist (audit F-10, F-11).
- Acceptance:
  1. The catalog contains exactly the required names with unique IDs and no undocumented stable entry.
  2. CI regenerates and clean-diffs exports, adapter inventories, registry metadata, stories, docs matrices, and test manifests.
  3. A missing anatomy, vector, accessibility rule, or framework support declaration fails generation.
- Vectors: `TV-CAT-001-P`, `TV-CAT-001-N`.

### CAT-002 — Collections and shared algorithms

- Statement: Core MUST provide shared, tested collection, typeahead, selection, navigation, range, value-text, locale, and ID algorithms used by all applicable primitives.
- Rationale: Primitive-local implementations multiply defects and parity work (audit F-02, F-10).
- Acceptance:
  1. Applicable primitives import canonical algorithms rather than duplicating them.
  2. Algorithms support disabled items, dynamic reorder/removal, duplicates policy, Unicode normalization, locale collation, RTL, and virtualization hooks.
  3. Property/model tests compare algorithm outputs against declared invariants over generated sequences.
- Vectors: `TV-CAT-002-P`, `TV-CAT-002-N`.

### PRIM-001 — Disclosure, static, and identity families

- Statement: Accordion, Avatar, Button, Collapsible, Field, Fieldset, Form, ImageCropper, Input, Marquee, QRCode, ScrollArea, Separator, and Toolbar MUST implement their canonical native/APG semantics through core controllers where interactive and typed static contracts where not.
- Rationale: Stable breadth must include polished non-overlay foundations, not only machine-shaped widgets (audit F-10).
- Acceptance:
  1. Every primitive has positive/negative behavior, accessibility, SSR, source/package, and adapter vectors.
  2. Static primitives add no runtime subscription/effect cost unless a feature requires it.
  3. Native elements are preferred and invalid ARIA/native substitutions fail lint/contract tests.
- Vectors: `TV-PRIM-001-P`, `TV-PRIM-001-N`.

### PRIM-002 — Overlay and modal families

- Statement: AlertDialog, Dialog, Drawer, FloatingPanel, HoverCard, Popover, Tooltip, and Tour MUST use the shared layer, focus, modal, portal, presence, and positioning services with primitive-specific dismissal/focus rules.
- Rationale: Overlay correctness is currently fragmented across frameworks (audit F-03, F-04, F-12).
- Acceptance:
  1. Each primitive declares modal/non-modal, autofocus, dismissal, restore, interaction, and accessible-name rules.
  2. Nested cross-type overlay matrices pass keyboard, pointer, touch, shadow, portal, and unmount cases.
  3. AlertDialog cannot outside-dismiss by default and requires an accessible title plus least-destructive focus strategy.
- Vectors: `TV-PRIM-002-P`, `TV-PRIM-002-N`.

### PRIM-003 — Menu and navigation families

- Statement: ContextMenu, Menu, Menubar, NavigationMenu, Pagination, Tabs, and TreeView MUST implement their specified roving focus, directional navigation, typeahead, selection, submenu, disabled-item, orientation, RTL, and restoration semantics.
- Rationale: Navigation primitives expose deep keyboard/collection edge cases that generic click tests cannot prove (audit F-05, F-12).
- Acceptance:
  1. APG/native keyboard tables are encoded as executable vectors per primitive.
  2. Dynamic item changes preserve or repair active/selected state deterministically.
  3. Nested submenu pointer grace, keyboard open/close, and focus return pass real-browser tests.
- Vectors: `TV-PRIM-003-P`, `TV-PRIM-003-N`.

### PRIM-004 — Selection and collection families

- Statement: Checkbox, CheckboxGroup, Combobox, Listbox, RadioGroup, SegmentGroup, Select, TagsInput, Toggle, and ToggleGroup MUST share canonical selection/collection behavior and native form integration.
- Rationale: Current selection logic is duplicated and adapter coverage is uneven (audit F-02, F-03, F-06).
- Acceptance:
  1. Controlled/uncontrolled, single/multiple, nullable/required, disabled/readonly, dynamic, and reset semantics are explicit and tested.
  2. Value identity and serialization are deterministic for primitives and objects via declared item adapters.
  3. Keyboard, IME, touch, form, label/description/error, and announcement vectors pass on all three frameworks.
- Vectors: `TV-PRIM-004-P`, `TV-PRIM-004-N`.

### PRIM-005 — Text, editable, and file-input families

- Statement: Autocomplete, Clipboard, Editable, FileUpload, NumberInput, PasswordInput, and PinInput MUST implement composition-safe text behavior, validation, selection/caret preservation, native form semantics, and secure/default-safe handling appropriate to each primitive.
- Rationale: Input widgets fail easily under IME, async updates, browser autofill, files, and controlled reconciliation (audit F-12, F-13).
- Acceptance:
  1. Composition events do not prematurely filter, commit, mask, or move the caret.
  2. Clipboard and file operations are capability-injected, permission/error aware, and never serialize secret/file content into traces.
  3. Locale parsing, stepping, paste, autofill, reset, and async-controlled update races pass browser vectors.
- Vectors: `TV-PRIM-005-P`, `TV-PRIM-005-N`.

### PRIM-006 — Range and gesture families

- Statement: AngleSlider, Carousel, RatingGroup, Slider, SignaturePad, and Splitter MUST provide keyboard, pointer, touch, multi-pointer, RTL/orientation, bounds, precision, cancellation, and reduced-motion semantics through shared algorithms.
- Rationale: Gesture components require more than click/keydown smoke checks and currently lack central rigor (audit F-05, F-10, F-12).
- Acceptance:
  1. Pointer capture/cancel/lost-capture and touch-scroll arbitration cannot leave a stuck interaction.
  2. Keyboard increments, Page/Home/End, RTL/orientation, min/max/step, and multi-thumb collision rules are exact.
  3. Accessible value text and announcements are locale-aware and rate-limited where continuous movement occurs.
- Vectors: `TV-PRIM-006-P`, `TV-PRIM-006-N`.

### PRIM-007 — Date, time, and color families

- Statement: ColorPicker, DateInput, DatePicker, and Timer MUST use explicit locale/timezone/calendar/color models and MUST NOT depend on host parsing, ambient timezone, or display string identity.
- Rationale: These domains are highly stateful and localization-sensitive; current catalog rigor is insufficient (audit F-10, F-12, F-13).
- Acceptance:
  1. Zoned/DST boundary, non-US locale, week-start, min/max/unavailable, segment editing, and calendar navigation vectors pass deterministically.
  2. Color parsing/conversion clamps and round-trips within declared tolerances across supported spaces and alpha.
  3. Timer pause/resume/drift/visibility behavior uses injected clocks and does not accumulate interval drift beyond budget.
- Vectors: `TV-PRIM-007-P`, `TV-PRIM-007-N`.

### PRIM-008 — Status and workflow families

- Statement: Meter, Progress, Steps, Toast, and TreeView workflow/status behavior MUST expose correct value/state semantics, live announcements where appropriate, queue/timeout/pause behavior, and deterministic lifecycle.
- Rationale: Feedback components need announcement and timing policies that synthetic rendering does not prove (audit F-05, F-12).
- Acceptance:
  1. Native role/value/name semantics match indeterminate/determinate/current/completed/error states.
  2. Toast queues, limits, timers, hover/focus/window pause, swipe, duplicate policy, and announcement ordering pass fake-clock and real-browser tests.
  3. Destroy and route changes clear timers/live regions without losing required final callbacks.
- Vectors: `TV-PRIM-008-P`, `TV-PRIM-008-N`.

### I18N-001 — Internationalization and bidirectionality

- Statement: All applicable primitives MUST support injected locale, direction, timezone, localized value text/messages, Unicode/IME input, and bidirectional keyboard/geometry behavior without English or LTR assumptions.
- Rationale: Accessibility and production support include language/direction correctness, not only translated labels (audit F-12, F-13).
- Acceptance:
  1. Arabic RTL, Hindi, Japanese IME, and at least one European locale are present in deterministic cross-framework scenarios.
  2. Physical versus logical key behavior is declared per primitive and verified.
  3. User-visible default strings are overridable/localizable and no English sentence is hardcoded in core behavior.
- Vectors: `TV-I18N-001-P`, `TV-I18N-001-N`.

## Frameworks and parity

### ADAPT-001 — Thin adapter kit and semantic trace

- Statement: `@uifn/adapter-kit` MUST translate controller snapshots/subscriptions/parts into framework bindings and semantic traces only; it MUST NOT implement primitive behavior or DOM services.
- Rationale: Current conformance is generic and can pass while public components diverge (audit F-03, F-05).
- Acceptance:
  1. Dependency/static scans reject primitive names, key maps, focus/layer code, or local transition stores in adapter-kit.
  2. Shared trace schema covers event, snapshot, actions, parts, callback, DOM/ARIA/focus, errors, and cleanup.
  3. Trace normalization preserves semantic differences and removes only framework-specific nondeterminism.
- Vectors: `TV-ADAPT-001-P`, `TV-ADAPT-001-N`.

### REACT-001 — React compound API

- Statement: `@uifn/react` MUST provide controller hooks and complete compound components for every catalog primitive, built only from core controllers and DOM services, compatible with React 18.3 and 19 SSR/hydration/concurrency behavior.
- Rationale: Current React compounds can own behavior and app-level DX trails mature primitives (audit F-03, F-05).
- Acceptance:
  1. Every anatomy part has a typed component with `asChild`/render composition, ref forwarding, controlled/uncontrolled events, and provider scoping as specified.
  2. StrictMode double invoke, transitions, Suspense, streaming SSR, hydration, portal, form, and unmount races pass.
  3. No React component recreates selection, keyboard, focus, layer, positioning, or timer logic.
- Vectors: `TV-REACT-001-P`, `TV-REACT-001-N`.

### SVELTE-001 — Svelte compound API

- Statement: `@uifn/svelte` MUST provide complete Svelte 5 rune-compatible compound components/actions for every catalog primitive, sourced only from controllers and DOM services, with compiled package exports and SSR-safe lifecycle.
- Rationale: Current Svelte components still call legacy creators and publish raw TypeScript as package source (audit F-03, F-11, F-13).
- Acceptance:
  1. Every anatomy part has a typed Svelte component/snippet composition contract and bindable values where specified.
  2. Reactive input updates do not recreate services or duplicate effects; SSR/hydration/action teardown pass.
  3. Packed exports contain compiled JS, declarations, Svelte metadata, and no repository-only source paths.
- Vectors: `TV-SVELTE-001-P`, `TV-SVELTE-001-N`.

### SOLID-001 — Solid compound API

- Statement: `@uifn/solid` MUST provide complete native Solid compound components for every catalog primitive, sourced only from controllers and DOM services, with fine-grained reactive updates and SSR/hydration safety.
- Rationale: Solid currently has only seven compound families and generic factories for the rest (audit F-06).
- Acceptance:
  1. Catalog and exported compound inventory match React/Svelte feature-for-feature.
  2. Accessors and stores update without stale destructuring, service recreation, or whole-tree invalidation.
  3. SolidStart-style SSR/hydration, portals, forms, cleanup, and owner-root disposal pass.
- Vectors: `TV-SOLID-001-P`, `TV-SOLID-001-N`.

### PARITY-001 — Actual public-component parity

- Statement: Cross-framework conformance MUST mount and operate the actual exported public compound trees for every canonical vector and compare normalized semantic traces; synthetic controller-only or generic factories cannot satisfy parity.
- Rationale: Current adapter verifiers can report green without exercising equivalent public UI (audit F-05, F-06).
- Acceptance:
  1. React, Svelte, and Solid traces match the golden semantic outcome for every applicable vector.
  2. A seeded mutation in any framework callback, ARIA prop, focus result, event order, or cleanup makes the gate fail.
  3. Framework-specific differences require an explicit catalog exception, rationale, and framework-specific vectors.
- Vectors: `TV-PARITY-001-P`, `TV-PARITY-001-N`.

### COMPAT-001 — Supported runtime matrix

- Statement: Stable packages MUST pass React 18.3/19, Svelte 5, current Solid 1.x, Node 20/22/24, latest two Chrome/Firefox/Edge, current and previous Safari/iOS Safari, and current Android Chrome.
- Rationale: Current verification is mostly one local Node/jsdom/Chromium environment (audit F-13).
- Acceptance:
  1. CI/device evidence records exact versions, OS/device, commit, package tarball hashes, and result for every matrix cell.
  2. Framework peer ranges and exports match the tested matrix.
  3. Missing, stale, skipped, or unexpected-pass cells are explicit and release-blocking unless listed as an approved outage with expiry.
- Vectors: `TV-COMPAT-001-P`, `TV-COMPAT-001-N`.

## Styling, hooks, and distribution

### COMP-001 — Framework-isolated styled components

- Statement: Styled compounds MUST be split into `@uifn/components-react`, `@uifn/components-svelte`, and `@uifn/components-solid`; the framework-neutral `@uifn/components` package MUST contain only portable definitions/metadata and no framework peers or behavior forks.
- Rationale: The current all-framework package is large, coupled, and contains demo/product behavior (audit F-07).
- Acceptance:
  1. Installing one styled framework package does not install or pack another framework adapter/peer.
  2. Styled compounds are open, composable anatomy wrappers with no fixed records, identities, dates, commands, navigation, or product workflows.
  3. Semantic trace comparison proves styled wrappers preserve headless behavior and accessibility.
- Vectors: `TV-COMP-001-P`, `TV-COMP-001-N`.

### STYLE-001 — Tokens, themes, recipes, and user preferences

- Statement: Tokens, themes, Tailwind integration, and recipes MUST be behavior-free, typed, tree-shakeable, and support light/dark/system, forced colors, reduced motion, contrast, density, RTL, and consumer overrides without semantic breakage.
- Rationale: Visual readiness must preserve accessibility preferences and package isolation (audit F-07, F-12, F-14).
- Acceptance:
  1. Token schema validates references, fallbacks, contrast pairs, motion alternatives, and forbidden hardcoded semantic colors.
  2. Forced-colors, reduced-motion, zoom, RTL, and theme switching pass visual/behavior matrices.
  3. Recipes target documented part/data attributes and cannot require private runtime state.
- Vectors: `TV-STYLE-001-P`, `TV-STYLE-001-N`.

### HOOK-001 — Portable hooks and utilities

- Statement: Hooks packages MUST expose only behavior-neutral reusable framework utilities, use injected environments, obey framework lifecycle rules, and MUST NOT fork primitive behavior already owned by core/DOM.
- Rationale: Local hooks are a common path for renewed drift (audit F-03).
- Acceptance:
  1. Each hook has SSR, cleanup, strict/reactivity, package, and source-install vectors in every supported framework where it exists.
  2. Static analysis rejects duplicated selection, typeahead, focus scope, dismissable layer, or positioning implementations.
  3. Hook APIs and support differences are inventory-driven and documented.
- Vectors: `TV-HOOK-001-P`, `TV-HOOK-001-N`.

### GEN-001 — One package/source generation pipeline

- Statement: Package exports and copied-source outputs MUST be generated from the same canonical logic, anatomy, vectors, and templates, and MUST produce equivalent semantic traces in a clean consumer.
- Rationale: Current package and source trees are hand-maintained duplicates despite checksum tooling (audit F-11).
- Acceptance:
  1. Regeneration is deterministic, format-stable, and produces a clean diff from a clean checkout.
  2. Clean package-install and source-install fixtures pass identical type, build, SSR, browser, accessibility, and semantic-vector suites.
  3. A source template changed without the canonical definition fails drift verification.
- Vectors: `TV-GEN-001-P`, `TV-GEN-001-N`.

### REG-001 — Safe registry CLI

- Statement: Registry/source installation MUST verify schema, framework, dependency graph, checksums/signatures, license/provenance, path containment, conflicts, and atomic rollback before modifying a consumer project.
- Rationale: Source installation is first-class and therefore must be safe under failure and hostile metadata (audit F-11, F-15).
- Acceptance:
  1. Dry-run reports exact creates/updates/dependencies and makes no file changes.
  2. Traversal, symlink escape, checksum mismatch, unsupported framework, dirty conflict, interrupted write, and dependency-cycle fixtures fail safely with full rollback.
  3. Successful repeated installation is idempotent and records canonical source/version provenance.
- Vectors: `TV-REG-001-P`, `TV-REG-001-N`.

## Quality, accessibility, and release

### STORY-001 — Live Storybook as executable surface

- Statement: A built Storybook MUST render every stable primitive, anatomy, required state/variant, framework, theme, direction, preference mode, and accessibility fixture from public packages, with interaction tests and no metadata-only substitutions.
- Rationale: Current story verification can pass generated metadata while live-story coverage remains incomplete (audit F-17).
- Acceptance:
  1. Canonical inventory and built story index have exact required coverage.
  2. Playwright visits and operates every required story; console/page/network/a11y failures block.
  3. A removed story export or story that mounts a test double is detected.
- Vectors: `TV-STORY-001-P`, `TV-STORY-001-N`.

### DOCS-001 — Complete, runnable documentation

- Statement: Stable documentation MUST describe every primitive’s anatomy, controlled/uncontrolled API, events, accessibility behavior, keyboard/touch behavior, SSR, forms, composition, styling, package/source installation, limitations, and migration, using runnable public-package examples.
- Rationale: Production maturity includes accurate consumer guidance and disclosed limits (audit F-10, F-11, F-17).
- Acceptance:
  1. A docs coverage schema maps every catalog field to a rendered page/section and fails missing content.
  2. Every code sample typechecks/builds in clean supported-framework fixtures.
  3. Link, version, removed-API, unsupported-framework, and stale generated-snippet checks pass.
- Vectors: `TV-DOCS-001-P`, `TV-DOCS-001-N`.

### A11Y-001 — Normative accessibility ledger

- Statement: Every primitive MUST have a reviewed ledger mapping applicable WCAG 2.2 AA criteria, APG/native patterns, roles/properties/states, accessible-name/description rules, keyboard/pointer/touch/focus behavior, announcements, high-contrast/reflow/motion requirements, and non-applicable rationale.
- Rationale: A generic `wcagLevel: AA` marker is not accessibility evidence (audit F-01, F-12).
- Acceptance:
  1. Every stable primitive and behavior mode has a ledger entry approved by an accessibility owner.
  2. Each applicable rule maps to canonical automated/manual vectors and evidence IDs.
  3. Unjustified `not-applicable`, missing APG deviations, or stale ledger revisions fail release.
- Vectors: `TV-A11Y-001-P`, `TV-A11Y-001-N`.

### A11Y-002 — Automated accessibility and interaction evidence

- Statement: Every required public-package and source-install fixture MUST pass axe plus explicit keyboard, focus, name/description, role/state, form, live-region, pointer/touch, RTL, forced-colors, reduced-motion, and 200%/400% zoom/reflow assertions in the applicable browser matrix.
- Rationale: Axe alone cannot prove interaction or screen-reader behavior, and current smoke assertions accept irrelevant zero-action results (audit F-05, F-12).
- Acceptance:
  1. Assertions are primitive-specific and must observe the required transition/result; irrelevant assertions are absent, not auto-passed.
  2. Zero serious/critical axe violations and zero unresolved required explicit assertions exist.
  3. Failure artifacts include sanitized DOM, event/semantic trace, focus path, screenshot, browser/framework/version, and stable failure code.
- Vectors: `TV-A11Y-002-P`, `TV-A11Y-002-N`.

### A11Y-003 — Manual assistive-technology matrix

- Statement: Signed human testing MUST cover VoiceOver on macOS and iOS, NVDA on Windows, and TalkBack on current Android across the representative primitive/state matrix in `SPEC.md`; JAWS alone is deferred.
- Rationale: Current manual evidence explicitly records that no human verifier was available (audit F-01).
- Acceptance:
  1. Evidence records tester, date, commit/tarball hashes, OS/device/browser/AT versions, exact script, observed speech/braille-equivalent output where applicable, result, defects, and signature.
  2. The matrix covers every behavior family, high-risk primitive, destructive/modal path, forms, dynamic updates, errors, and source/package install.
  3. Unsigned, self-asserted-by-automation, stale, incomplete, or blocked rows fail release.
- Vectors: `TV-A11Y-003-P`, `TV-A11Y-003-N`.

### A11Y-004 — Independent review and 10/10 accessibility gate

- Statement: A qualified reviewer independent of implementation MUST audit the normative ledger, automation, manual scripts/evidence, representative code, and open defects, and MUST sign an unqualified 10/10 release assessment before 1.0.
- Rationale: The user explicitly required independent review and evidence-backed accessibility confidence.
- Acceptance:
  1. Reviewer identity, independence statement, scope, method, findings, retest evidence, and signature are present.
  2. No open P0/P1 accessibility defect, no unaccepted P2 affecting a required matrix row, and no missing required evidence remains.
  3. The published support statement discloses the JAWS deferment without implying untested support.
- Vectors: `TV-A11Y-004-P`, `TV-A11Y-004-N`.

### TEST-001 — Layered, adversarial, and regression testing

- Statement: Every stable capability MUST have unit, model/property, contract, adapter, SSR/hydration, real-browser, accessibility, source/package, mutation, cleanup, and regression coverage proportional to risk.
- Rationale: Current high counts include synthetic/generic checks that do not establish semantic rigor (audit F-05, F-18).
- Acceptance:
  1. Coverage is reported by requirement/vector/primitive/behavior family, not only lines or test totals.
  2. Seeded defect mutations for event ordering, ARIA, focus, cleanup, package drift, and framework divergence are killed by the intended gate.
  3. Every fixed P0/P1 defect receives a permanent minimal regression vector.
- Vectors: `TV-TEST-001-P`, `TV-TEST-001-N`.

### PERF-001 — Bundle and tree-shaking budgets

- Statement: Packed consumer fixtures MUST meet the gzip and tree-shaking budgets in `SPEC.md`, with no unintended framework, primitive, test, story, source-map, or product-demo code.
- Rationale: Current tarballs are large and components couple all frameworks; no hard consumer budgets exist (audit F-07, F-14).
- Acceptance:
  1. Reproducible esbuild and Rollup/Vite fixtures measure every specified simple/complex/controller/DOM/styled cell against the hard limits.
  2. Importing one primitive retains no other primitive or framework adapter unless declared shared code is used.
  3. Packed contents and source maps are allowlisted; a one-byte budget excess blocks release.
- Vectors: `TV-PERF-001-P`, `TV-PERF-001-N`.

### PERF-002 — Runtime latency and leak budgets

- Statement: Controller dispatch, DOM response, overlay open, virtualization, and post-destroy resource usage MUST meet the p95/p99, long-task, detached-node, listener/observer/timer, and heap budgets in `SPEC.md` on declared reference devices.
- Rationale: Production confidence requires measured performance and lifecycle safety, not subjective smoothness (audit F-08, F-14).
- Acceptance:
  1. Benchmarks use fixed fixtures, warmup, sample counts, reference hardware/browser, statistical summaries, and raw result artifacts.
  2. Stress tests repeat mount/interact/destroy and prove zero owned resource/detached-node leaks and heap delta within budget.
  3. Results outside budget, noisy/unreproducible runs, or missing reference-device evidence block release.
- Vectors: `TV-PERF-002-P`, `TV-PERF-002-N`.

### SEC-001 — Security, dependencies, licenses, and provenance

- Statement: Stable releases MUST pass threat-model review, dependency vulnerability/license policy, secret and unsafe-DOM scans, tarball inspection, SBOM generation, build provenance/attestation, artifact signing, and clean-room attribution review.
- Rationale: Current provenance checking is mostly keyword/metadata scanning and is insufficient for a 1.0 supply-chain claim (audit F-15).
- Acceptance:
  1. CycloneDX or SPDX SBOM covers direct/transitive runtime and build dependencies with resolved versions/licenses.
  2. No unapproved critical/high vulnerability, incompatible/unknown license, secret, unsafe HTML path, path traversal, or unsigned release artifact remains.
  3. Published tarball hashes map to tested tarballs, signed tags, immutable CI run, source commit, and SLSA-compatible provenance statement.
- Vectors: `TV-SEC-001-P`, `TV-SEC-001-N`.

### REL-001 — Evidence-backed release and defect gate

- Statement: The stable release verifier MUST derive its result from current immutable evidence for every requirement/vector/matrix/budget and MUST fail closed for missing, stale, blocked, skipped, malformed, or unresolved entries.
- Rationale: Current dry-run/checklist orchestration and huge generated evidence can overstate readiness (audit F-01, F-05, F-16, F-18).
- Acceptance:
  1. Evidence schema records source commit, clean/dirty state, command, environment, timestamps, versions, artifact hashes, result, and signer where required.
  2. One release summary maps every requirement to evidence and open defects; all required cells are machine-validated.
  3. Dry-run is always non-releasable and clearly distinct from an executed release gate.
- Vectors: `TV-REL-001-P`, `TV-REL-001-N`.

### REL-002 — Versioning, migration, and release integrity

- Statement: 1.0 MUST use coherent semver, synchronized compatibility metadata, changesets/changelogs, migration/codemod guidance, packed-artifact testing, signed publication, dist-tag verification, and rollback/deprecation procedures.
- Rationale: This program intentionally makes breaking changes and must give consumers a safe release path (audit F-11, F-15, F-16).
- Acceptance:
  1. Every stable package is 1.0-compatible and dependency/peer ranges resolve from a clean registry fixture.
  2. Migration examples cover removed legacy APIs, removed frameworks, styled-package split, environment injection, and package/source installation.
  3. A release candidate is installed from exact tarballs, passes the full gate, is signed/published atomically, and has a tested rollback procedure.
- Vectors: `TV-REL-002-P`, `TV-REL-002-N`.

## Completeness rule

No requirement may be marked complete from a checklist, code presence, test count, generated metadata, dry-run, or self-authored readiness statement alone. Completion requires all acceptance criteria, both listed vector classes, requirement-to-evidence traceability, and zero release-blocking defects.
