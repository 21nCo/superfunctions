# Metadata

- timestamp: 2026-03-26T18:02:15Z
- agent_name: audit
- model: unknown
- launcher: Codex Desktop
- workspace/project path: repo root
- os: Darwin arm64
- shell: zsh
- git: branch `HEAD (detached)`; commit `50929162a8547f6f55db27bdc51c47289c0bc2af`; dirty status `clean before audit artifacts`
- intent/notes paths audited:
  - external input (sanitized): user request for a thorough production-readiness audit of `drawfn` for use as a Nucleus drawing node, with a quality bar similar to tldraw or Excalidraw
  - `drawfn/core/README.md`
  - `drawfn/drawfn-react/README.md`
  - `drawfn/drawfn-svelte/README.md`
- spec bundle paths audited:
  - `drawfn/core/` with `SPEC.md`
  - no drawfn-specific `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, `INTENT_AUDIT.md`, or `phases/` bundle was present
- codebase scope audited:
  - `drawfn/core`
  - `drawfn/drawfn-react`
  - `drawfn/drawfn-svelte`
  - excluded: historical artifacts under `.conduct/audits/`, non-drawfn packages
- commands executed during audit: see Appendix

# Audit scope

This was a full, read-only audit of the implemented `drawfn` packages against the user intent, the drawfn package docs, and the only drawfn-specific spec artifact available in-repo: `drawfn/core/SPEC.md`.

The audit covered API design, packaging, framework adapters, interaction correctness, persistence/versioning, export behavior, Nucleus integration, documentation consistency, and available verification evidence.

Verification limitation: local workspace scripts could not be re-run from the checked-out repo because the drawfn workspace was not bootstrapped in this environment (`tsc`, `tsup`, and `vitest` were unavailable on PATH for the package scripts). Static evidence was still sufficient to confirm multiple blocker-class defects.

# Inputs audited (intent + spec bundles)

## Intent inputs

1. External user request:
   - Production readiness for Nucleus embedding as a drawing node.
   - Quality bar "similar to tldraw or Excalidraw".
2. `drawfn/core/README.md`:
   - Public install surface, API claims, keyboard/mouse UX promises, export options.
3. `drawfn/drawfn-react/README.md`:
   - React adapter API, controlled mode, `onReady`, export examples.
4. `drawfn/drawfn-svelte/README.md`:
   - Svelte action/component/store API, controlled mode, export examples.

## Spec inputs

1. `drawfn/core/SPEC.md`
   - Goals, architecture, data model, public API, tools, rendering, performance, persistence, Nucleus integration, bindings, input/accessibility, hit testing, packaging, acceptance criteria.

## Historical context reviewed after independent analysis

- `drawfn/core/AUDIT-2026-01-08.md`
  - Used only as historical context after the independent audit was already formed.
  - Not used as a pass/fail authority.

# High-level findings

1. Release blocker: the published package surface is internally inconsistent and the adapters are not releasable as written.
   - `drawfn/core/package.json` publishes `drawfn`, while adapter source and docs import `@21n/drawfn`.
   - `drawfn/drawfn-react/package.json` depends on `drawfn`, but `drawfn/drawfn-react/src/use-drawfn.ts` and `drawfn/drawfn-react/src/index.ts` import/export `@21n/drawfn`.
   - `drawfn/drawfn-svelte/src/DrawfnCanvas.svelte` binds `canvas` on `<Canvas ...>` even though `drawfn/drawfn-svelte/src/Canvas.svelte` does not export a `canvas` prop.
2. Release blocker: interactive state semantics are not production-safe.
   - Interactive mutations record history on every frame because tools call `context.updateElement()` repeatedly and `Drawfn.update()` records history every time.
   - Selection changes during pointer interactions mutate `selectedIds` directly without emitting `selectionChanged`, so adapter stores and hosts cannot reliably observe selection state.
   - Re-editing existing text mutates live scene state without going through `Drawfn.update()`, so it bypasses history, events, and guaranteed rerender.
3. Release blocker: several user-visible behaviors are incorrect in core drawing flows.
   - `PenTool` mixes absolute and relative point coordinates.
   - Locked elements are hidden instead of rendered non-interactively.
   - Wheel zoom anchoring uses mismatched coordinate spaces once the camera is already offset.
4. Major: Nucleus integration is not implemented to spec.
   - `onNodeClick` and `getNodePreview` are stored on `Drawfn`, but never used.
   - The spec's preview-fetcher registration hook is absent.
5. Major: export and image-loading paths are incomplete.
   - Async image loads never schedule a repaint.
   - `exportPNG()` constructs a new renderer without the custom image loader, so authenticated/custom image loading does not carry into export.
6. Major: the drawfn spec surface itself is incomplete for a release gate.
   - There is no drawfn `REQUIREMENTS.md`, `TEST_VECTORS.md`, or phase bundle, so production-readiness expectations are underspecified and untestable in a formal way.

Overall conclusion: `drawfn` is not production-ready for Nucleus use at a tldraw/Excalidraw-class quality bar in its current state.

# Intent Inventory

1. `drawfn` must be production-ready for embedding in a Nucleus host, not just a prototype canvas.
2. The UX quality bar is similar to tldraw/Excalidraw for core single-user whiteboard flows.
3. The core library must be framework-agnostic and usable in frontend projects beyond Nucleus.
4. React and Svelte wrappers must be thin, working bindings over the same core API.
5. The element model must support freedraw, rectangle, ellipse, arrow, text, image, and Nucleus node elements.
6. Scene data must be JSON-serializable, versioned, round-trip safe, and tolerant to compatible loads.
7. Users must be able to create, edit, and delete all supported element types.
8. Selection must support click selection, shift-selection, marquee selection, move, resize, rotate, and delete.
9. Navigation must support pan, zoom-at-cursor, keyboard shortcuts, and pointer-based interaction.
10. Text editing must use a DOM overlay and must reliably commit/re-edit existing text.
11. Nucleus node elements must support bookmark/card rendering, preview metadata, preview fetching, and click/open behavior into the host.
12. Rendering must use camera transforms, viewport culling, rotation-aware handles, and zoom-consistent selection UI.
13. History must support undo/redo at meaningful action boundaries rather than per-frame noise.
14. PNG and SVG export must work for real host content, including images when a custom image loader is required.
15. Package naming, install commands, exported modules, and license metadata must be internally consistent and publishable.
16. Production readiness must be backed by runnable builds, runnable adapters, and enough tests or demo evidence to trust the package in a real app.

# Intent -> Spec coverage matrix

| Intent # | Intent statement | Spec mapping | Spec coverage | Implementation status | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Production-ready for Nucleus embedding | `drawfn/core/SPEC.md:7`, `drawfn/core/SPEC.md:192`, `drawfn/core/SPEC.md:308` | SPEC MISSING: no release gates, no test vectors, no performance budgets | FAIL | No drawfn requirement bundle; adapter/package blockers; limited tests |
| 2 | tldraw/Excalidraw-class core UX | `drawfn/core/SPEC.md:165`, `drawfn/core/SPEC.md:228`, `drawfn/core/README.md:121` | PARTIAL | FAIL | No pointer capture, incorrect zoom anchor, broken history granularity |
| 3 | Framework-agnostic core | `drawfn/core/SPEC.md:8`, `drawfn/core/SPEC.md:32` | COVERED | PARTIAL | Core package exists, but docs/package surface conflicts reduce actual portability |
| 4 | React + Svelte thin wrappers over same API | `drawfn/core/SPEC.md:203`, `drawfn/core/SPEC.md:223`, `drawfn/core/SPEC.md:313` | COVERED | FAIL | Adapter import and Svelte binding defects prevent reliable wrapper usage |
| 5 | Support all v1 element types | `drawfn/core/SPEC.md:39`, `drawfn/core/SPEC.md:308` | COVERED | PARTIAL | Types exist; freedraw and node behavior are not production-correct |
| 6 | JSON-serializable, versioned, tolerant scene loading | `drawfn/core/SPEC.md:106`, `drawfn/core/SPEC.md:115`, `drawfn/core/SPEC.md:187`, `drawfn/core/SPEC.md:309` | COVERED | FAIL | `load()` bypasses validation; `loadScene()` breaks on numeric spec version |
| 7 | Create/edit/delete all supported element types | `drawfn/core/SPEC.md:171`, `drawfn/core/SPEC.md:308` | COVERED | PARTIAL | Existing-text re-edit is broken; wrappers miss some state sync paths |
| 8 | Click/shift/marquee/move/resize/rotate/delete selection | `drawfn/core/SPEC.md:166`, `drawfn/core/README.md:45`, `drawfn/core/README.md:133` | COVERED | FAIL | Selection events not emitted; marquee uses center-point heuristic; rotation visuals mismatch interaction |
| 9 | Pan, zoom-at-cursor, shortcuts, pointer interaction | `drawfn/core/SPEC.md:167`, `drawfn/core/SPEC.md:229`, `drawfn/core/README.md:121` | COVERED | FAIL | Wheel anchor math is wrong under offset camera; space-to-pan focus model is weak |
| 10 | Reliable DOM-overlay text editing and re-edit | `drawfn/core/SPEC.md:171`, `drawfn/core/SPEC.md:179` | COVERED | FAIL | Existing text re-edit mutates scene directly without events/history/render |
| 11 | Nucleus node preview + click/open integration | `drawfn/core/SPEC.md:192`, `drawfn/core/SPEC.md:197`, `drawfn/core/SPEC.md:314` | PARTIAL | FAIL | Preview fetcher and click routing are not actually wired |
| 12 | Camera transforms, culling, rotation-aware handles | `drawfn/core/SPEC.md:175`, `drawfn/core/SPEC.md:181`, `drawfn/core/SPEC.md:233` | COVERED | FAIL | Locked elements are hidden; culling and selection visuals ignore oriented bounds |
| 13 | Action-level undo/redo | `drawfn/core/SPEC.md:153`, `drawfn/core/SPEC.md:311`, `drawfn/core/README.md:94` | COVERED | FAIL | Interactive updates spam history entries on every move |
| 14 | PNG/SVG export works in real host conditions | `drawfn/core/SPEC.md:157`, `drawfn/core/SPEC.md:312`, `drawfn/core/README.md:102` | COVERED | PARTIAL | Basic export paths exist, but image-loader propagation and option semantics are incomplete |
| 15 | Publish surface and docs are coherent | `drawfn/core/SPEC.md:205`, `drawfn/core/SPEC.md:245`, `drawfn/core/README.md:16`, `drawfn/drawfn-react/README.md:5`, `drawfn/drawfn-svelte/README.md:5` | SPEC CONFLICT | FAIL | Package names and licenses disagree across spec, README, and package.json |
| 16 | Runnable build/test/demo evidence | `drawfn/core/SPEC.md:313` | SPEC MISSING/PARTIAL | FAIL | No drawfn test vectors; adapter packages have no tests; local scripts could not run without bootstrap |

# Requirement coverage summary

No official drawfn `REQUIREMENTS.md` exists, so the table below audits derived requirement IDs (`DSPEC-*`) synthesized from `drawfn/core/SPEC.md`, the package READMEs, and the stated acceptance criteria.

| Spec bundle | Official REQUIREMENTS.md count | Derived requirements audited | PASS | PARTIAL | FAIL | UNVERIFIED | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `drawfn/core/SPEC.md` | 0 | 18 | 1 | 4 | 13 | 0 | Formal requirement/test-vector bundle is missing |

# Requirement-by-requirement results

| ID | Derived requirement statement | Status | Primary evidence |
| --- | --- | --- | --- |
| DSPEC-01 | Serializable element model exists for all v1 element types | PARTIAL | `drawfn/core/src/types.ts:1`, `drawfn/core/src/tools/pen-tool.ts:22` |
| DSPEC-02 | Scene loading/export is deterministic, versioned, and tolerant | FAIL | `drawfn/core/src/drawfn.ts:83`, `drawfn/core/src/drawfn.ts:99`, `drawfn/core/src/drawfn.ts:134` |
| DSPEC-03 | Core API exposes scene CRUD, z-order, tool, camera, history, and export methods | PASS | `drawfn/core/src/drawfn.ts:225`, `drawfn/core/src/index.ts:1` |
| DSPEC-04 | Selection supports marquee, move, resize, rotate, delete, and host-visible selection events | FAIL | `drawfn/core/src/tools/select-tool.ts:97`, `drawfn/core/src/tools/select-tool.ts:157`, `drawfn/core/src/drawfn.ts:759` |
| DSPEC-05 | Pan/zoom supports wheel-at-cursor and practical space-to-pan behavior | FAIL | `drawfn/core/src/drawfn.ts:654`, `drawfn/core/src/drawfn.ts:681` |
| DSPEC-06 | Freehand recording/rendering is coordinate-correct and pressure-aware | FAIL | `drawfn/core/src/tools/pen-tool.ts:22`, `drawfn/core/src/tools/pen-tool.ts:59`, `drawfn/core/src/renderer.ts:164` |
| DSPEC-07 | Text tool supports new text and re-editing existing text with correct commit semantics | FAIL | `drawfn/core/src/tools/text-tool.ts:56`, `drawfn/core/src/tools/text-tool.ts:97`, `drawfn/core/src/drawfn.ts:334` |
| DSPEC-08 | Image loading and export work with lazy/custom loaders | FAIL | `drawfn/core/src/renderer.ts:270`, `drawfn/core/src/renderer.ts:416`, `drawfn/core/src/drawfn.ts:407` |
| DSPEC-09 | Node integration supports preview fetch and click/open callbacks | FAIL | `drawfn/core/src/drawfn.ts:24`, `drawfn/core/src/drawfn.ts:62`, `drawfn/core/src/renderer.ts:281` |
| DSPEC-10 | Renderer handles camera transforms, culling, rotation-aware selection, and visible locked elements | FAIL | `drawfn/core/src/renderer.ts:57`, `drawfn/core/src/renderer.ts:60`, `drawfn/core/src/renderer.ts:305` |
| DSPEC-11 | Performance hooks include viewport culling and debounced rendering | PARTIAL | `drawfn/core/src/renderer.ts:55`, `drawfn/core/src/drawfn.ts:722` |
| DSPEC-12 | Undo/redo operates at action granularity rather than per-pointer-move noise | FAIL | `drawfn/core/src/drawfn.ts:240`, `drawfn/core/src/drawfn.ts:252`, `drawfn/core/src/tools/select-tool.ts:145` |
| DSPEC-13 | PNG/SVG export meets public API expectations | PARTIAL | `drawfn/core/src/drawfn.ts:348`, `drawfn/core/src/drawfn.ts:449`, `drawfn/core/README.md:102` |
| DSPEC-14 | React wrapper compiles, exports the correct dependency surface, and supports controlled/uncontrolled scenes | FAIL | `drawfn/drawfn-react/package.json:49`, `drawfn/drawfn-react/src/use-drawfn.ts:2`, `drawfn/drawfn-react/src/use-drawfn.ts:63` |
| DSPEC-15 | Svelte wrapper compiles, exports the correct dependency surface, and supports controlled/uncontrolled scenes | FAIL | `drawfn/drawfn-svelte/src/Canvas.svelte:10`, `drawfn/drawfn-svelte/src/DrawfnCanvas.svelte:3`, `drawfn/drawfn-svelte/src/DrawfnCanvas.svelte:45` |
| DSPEC-16 | Keyboard and pointer accessibility behavior is host-safe | PARTIAL | `drawfn/core/src/drawfn.ts:625`, `drawfn/core/src/drawfn.ts:683`, `drawfn/core/src/drawfn.ts:692` |
| DSPEC-17 | Package names, install docs, and license metadata are consistent and publish-ready | FAIL | `drawfn/core/package.json:2`, `drawfn/core/README.md:1`, `drawfn/drawfn-react/package.json:2`, `drawfn/drawfn-svelte/package.json:2` |
| DSPEC-18 | Test and demo evidence is sufficient for a production-readiness release gate | FAIL | `drawfn/core/__tests__/drawfn.test.ts:1`, `drawfn/drawfn-react/package.json:20`, `drawfn/drawfn-svelte/package.json:28` |

## Per-requirement notes

- DSPEC-01: The declared model surface exists, but freedraw serialization is not reliable because `PenTool` seeds `currentPoints` with an absolute coordinate and later appends relative coordinates.
- DSPEC-02: `load()` is a raw deep clone with no tolerant parsing. `loadScene()` attempts tolerant parsing but uses `version.split(".")`, which fails for the spec's numeric `version: 1`.
- DSPEC-03: The core API surface is present and broadly matches the spec names.
- DSPEC-04: Pointer-based selection mutates the shared `selectedIds` set directly, but only `setSelection()` emits `selectionChanged`. Hosts observing selection via events will miss most real selection changes.
- DSPEC-05: The wheel zoom formula mixes world-space and camera-space coordinates after panning; space-to-pan also depends on the unfocusable canvas receiving keyboard events directly.
- DSPEC-06: The first freehand point is absolute, later points are relative, and rendering re-adds `element.x`/`element.y` to every point. This breaks coordinate correctness and round-trip safety.
- DSPEC-07: Existing-text re-edit uses `element.text = ...` inside `TextTool.editElement()` instead of `Drawfn.update()`, so no history, event, or guaranteed render occurs.
- DSPEC-08: `Renderer.loadImage()` never schedules a redraw after the image enters cache, so a newly loaded image can stay as a placeholder until another scene mutation occurs. `exportPNG()` also drops the custom image loader by constructing `new Renderer(tempCanvas)` with no loader.
- DSPEC-09: `DrawfnOptions` exposes `onNodeClick` and `getNodePreview`, but no pointer path invokes them, and the spec's `registerNodePreviewFetcher(...)` API is missing entirely.
- DSPEC-10: Locked elements are skipped from rendering altogether (`if (element.locked && !selectedIds.has(element.id)) continue;`). Selection visuals and culling both use axis-aligned bounds even when rotation exists.
- DSPEC-11: RAF debouncing and viewport culling are present, but they are weakened by incorrect bounds handling and the lack of repaint on async image completion.
- DSPEC-12: Tools call `context.recordHistory()` and then call mutators that record history again. Every drag frame creates another undo step, which is not acceptable for a whiteboard product.
- DSPEC-13: Export exists, but option semantics are incomplete. `exportPNG()` adds ad hoc options not documented in the public API, and `exportSVG()` ignores `padding`.
- DSPEC-14: React wrapper controlled mode reloads `scene` on every prop change via `drawfn.load(options.scene)`, which clears selection and history each time. It also imports the wrong core package name.
- DSPEC-15: Svelte wrapper has the same controlled-mode reload problem, imports the wrong core package name, and contains an invalid child binding contract (`bind:canvas` without a matching exported prop).
- DSPEC-16: Keyboard shortcuts exist, but delete/backspace is handled on `window` without guardrails for editing contexts, and no pointer capture or global pointerup fallback exists for drags that leave the canvas.
- DSPEC-17: Spec/docs say `@21n/drawfn*` and `Apache-2.0`; package metadata says `drawfn`, `@drawfn/react`, `@drawfn/svelte`, and `MIT`.
- DSPEC-18: Core has only a small unit suite and no adapter test surface. React and Svelte packages do not define a `test` script at all.

# Spec conflicts / spec gaps

## Spec conflicts

1. Package naming conflict
   - Spec/docs: `@21n/drawfn`, `@21n/drawfn-react`, `@21n/drawfn-svelte` in `drawfn/core/SPEC.md:205`, `drawfn/core/SPEC.md:245`, `drawfn/core/README.md:1`, `drawfn/drawfn-react/README.md:1`, `drawfn/drawfn-svelte/README.md:1`.
   - Implementation metadata: `drawfn`, `@drawfn/react`, `@drawfn/svelte` in package manifests.
   - Impact: publish/install instructions and adapter imports cannot all be correct at the same time.
2. License conflict
   - Package manifests declare `MIT`.
   - READMEs and `drawfn/core/IMPLEMENTATION.md` declare `Apache-2.0`.
   - Impact: release/legal metadata is ambiguous.

## Spec gaps

1. Missing formal requirement bundle
   - No drawfn `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, `INTENT_AUDIT.md`, or phase docs exist.
   - Impact: no authoritative requirement IDs or release vectors exist for a production audit.
2. Missing release/readiness thresholds
   - The user intent asks for tldraw/Excalidraw-class production readiness, but the spec does not define latency, stress, interoperability, or host-integration gates.
3. Missing wrapper state-sync contract
   - The spec says "controlled or uncontrolled scene" for React and a thin wrapper for Svelte, but does not define event semantics required for controlled mode without history loss.
4. Missing Nucleus API contract detail
   - The spec sketches a node preview fetcher and click behavior, but it does not define the public API shape beyond an inline example.

# Cross-cutting audits (security/determinism/limits/errors/compat)

## Security / authz / validation boundaries

- Positive:
  - No evidence of dynamic code execution or dangerous eval-style behavior.
  - Core image loading can be delegated to a host-provided loader.
- Risks:
  - `loadScene()` validation path is brittle and fails on the spec's own numeric version shape.
  - Global `window` keyboard listeners can act outside focused canvas intent; there is no focused-editing guard for delete/backspace.
  - Export paths do not preserve the host-provided image loader, which undermines authenticated image usage in real hosts.
  - Node callbacks are declared but not executed, so host navigation/security boundaries are effectively undefined in practice.

## Determinism invariants

- Scene round-trip determinism is not trustworthy for freedraw because point coordinates are stored inconsistently.
- `load()` deep-clones raw input without normalization; `loadScene()` is supposed to normalize but is incompatible with `version: 1`.
- Undo history includes per-frame intermediate states for drags/resizes/strokes, which makes action semantics non-deterministic from a user perspective.
- New IDs are time/random based, which is acceptable for creation but not useful for deterministic test fixtures unless controlled externally.

## Limits / caps

- Present:
  - history cap: 50 snapshots (`drawfn/core/src/history.ts`)
  - zoom clamp: 0.1 to 5 (`drawfn/core/src/drawfn.ts:183`, `drawfn/core/src/drawfn.ts:659`)
  - resize floor: 10 units (`drawfn/core/src/tools/select-tool.ts:296`)
- Missing:
  - no cap on freehand point count
  - no cap on element count
  - no cap on image cache growth
  - no export size guardrails for very large scenes

## Error handling + canonical envelopes

- Error handling is inconsistent:
  - `loadScene()` returns boolean and logs to console.
  - `exportPNG()` rejects with an exception.
  - `Renderer.loadImage()` swallows failures behind `console.error(...)`.
- There is no generic `sceneChanged` event, so adapters must subscribe to a subset of mutation events and currently miss `clear()`, `undo()`, `redo()`, and `load()`.

## Compatibility / versioning / migrations

- No migration path exists beyond a partially implemented `loadScene()` helper.
- `loadScene()` is incompatible with the declared scene version type.
- Adapter package/import conflicts break package compatibility at the publish boundary.
- Controlled wrapper implementations call `load()` on every incoming scene update, which clears history and selection and makes integration behavior unstable.

# Recommendations

1. Stop release work until the package surface is coherent.
   - Choose one public package namespace and make `package.json`, source imports, exports, and README install commands all agree.
   - Fix the Svelte adapter component contract (`bind:canvas` / exported prop mismatch) before any publish attempt.
2. Redesign interactive mutation semantics around action boundaries.
   - Separate "record history once at gesture start/end" from per-frame `updateElement()` calls.
   - Emit a single authoritative `sceneChanged` event and route all interactive selection changes through it or through `setSelection()`.
3. Fix correctness bugs in core editing flows.
   - Make freehand points consistently relative or consistently absolute.
   - Repair wheel zoom anchoring using stable screen-space math.
   - Render locked elements instead of hiding them.
   - Add pointer capture or a global pointerup path for robust drags.
4. Replace the text re-edit path with a real mutator-backed edit flow.
   - Existing-text edits must use `Drawfn.update()` and must rerender, emit events, and participate in history.
   - `destroy()` must clean up any active text overlay.
5. Finish Nucleus integration rather than only declaring hooks.
   - Implement preview fetching and node click routing in the core or expose an explicit integration API that hosts can actually use.
6. Repair export/image behavior.
   - Repaint after async image load completion.
   - Pass the custom image loader into export renderers.
   - Reconcile documented export options with implemented options and behavior.
7. Establish a real release gate.
   - Create a drawfn `REQUIREMENTS.md` and `TEST_VECTORS.md`.
   - Add adapter build/tests and at least one React and one Svelte demo verification path.
   - Expand tests beyond the current light core CRUD coverage.

# Appendix: commands run + environment details

## Commands run

- `rg --files drawfn .conduct`
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse HEAD`
- `git status --short`
- `sed -n '1,240p' drawfn/core/README.md`
- `sed -n '1,420p' drawfn/core/SPEC.md`
- `sed -n '1,420p' drawfn/core/IMPLEMENTATION.md`
- `sed -n '1,220p' drawfn/drawfn-react/README.md`
- `sed -n '1,220p' drawfn/drawfn-svelte/README.md`
- `sed -n '1,240p' package.json`
- `sed -n '1,240p' turbo.json`
- `wc -l drawfn/core/src/*.ts drawfn/core/src/tools/*.ts drawfn/core/__tests__/*.ts drawfn/core/package.json drawfn/drawfn-react/package.json drawfn/drawfn-svelte/package.json drawfn/drawfn-react/src/*.tsx drawfn/drawfn-react/src/*.ts drawfn/drawfn-svelte/src/*.ts drawfn/drawfn-svelte/src/*.svelte`
- `sed -n ...` / `nl -ba ...` across the drawfn core, React, and Svelte source files listed in this report
- `npm -w drawfn run lint`
- `npm -w drawfn run test -- --run`
- `npm -w drawfn run build`
- `npm -w @drawfn/react run lint`
- `npm -w @drawfn/react run build`
- `npm -w @drawfn/svelte run lint`
- `npm -w @drawfn/svelte run build`
- `npm exec --yes --package=tsx@4.20.3 -- tsx --version`
- `find drawfn -maxdepth 2 -type d -name dist -print`
- `sed -n '1,240p' drawfn/core/AUDIT-2026-01-08.md`

## Verification results from commands

- All package `lint`/`build`/`test` invocations were blocked by missing installed toolchain binaries in this checkout (`tsc`, `tsup`, `vitest` not found through the workspace scripts).
- `@drawfn/react` and `@drawfn/svelte` do not declare a `test` script in their manifests.
- No `dist/` directories were present under `drawfn/` during the audit.

## Environment details

- repo root: `repo root`
- os: `Darwin arm64`
- shell: `zsh`
- launcher: `Codex Desktop`
