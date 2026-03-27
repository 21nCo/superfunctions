# Requirement Table Of Contents

- `BOUNDARY-001`
- `SURFACE-001`
- `SURFACE-002`
- `SCENE-001`
- `SCENE-002`
- `HISTORY-001`
- `EVENTS-001`
- `INPUT-001`
- `INPUT-002`
- `TEXT-001`
- `RENDER-001`
- `EXPORT-001`
- `REACT-001`
- `SVELTE-001`
- `OBS-001`
- `QA-001`

## Requirement

- ID: `BOUNDARY-001`
- Priority: `P0`
- Statement: The implementation MUST restrict this fix bundle to drawfn core, React, and Svelte concerns, and MUST NOT expand, remove, migrate, or redesign node/Nucleus-specific public APIs or serialized node fields.
- Rationale: The user explicitly excluded Nucleus migration and related work from scope.
- Acceptance criteria:
  - `NodeElement` type shape remains unchanged.
  - `node` tool option shape remains unchanged.
  - No new node/Nucleus-specific callbacks, options, or docs requirements are introduced by this bundle.
  - Shared refactors MAY touch common files, but resulting node behavior MUST remain backward compatible.
- Test vectors: `TV-BOUNDARY-001`, `TV-BOUNDARY-002`
- Notes: Documentation/package-name corrections that incidentally mention node tools are allowed if they do not alter node semantics.

## Requirement

- ID: `SURFACE-001`
- Priority: `P0`
- Statement: The package manifests, exports, source imports, README install commands, and license statements MUST use the canonical identifiers `drawfn`, `@drawfn/react`, `@drawfn/svelte`, and `MIT`.
- Rationale: The audit found incompatible package names and conflicting license text across the published surface.
- Acceptance criteria:
  - `drawfn/core/package.json` names the core package `drawfn`.
  - `drawfn/drawfn-react/package.json` names the adapter `@drawfn/react`.
  - `drawfn/drawfn-svelte/package.json` names the adapter `@drawfn/svelte`.
  - README install snippets and import examples match the package manifests.
  - All drawfn README license statements match manifest license metadata.
- Test vectors: `TV-SURFACE-001`, `TV-SURFACE-002`
- Notes: This requirement does not require compatibility aliases for the removed `@21n/drawfn*` documentation errors.

## Requirement

- ID: `SURFACE-002`
- Priority: `P0`
- Statement: Each published drawfn package MUST expose a buildable, testable, and internally consistent public entry surface from repo root.
- Rationale: The current adapter packages are not releasable as written.
- Acceptance criteria:
  - Core, React, and Svelte packages each expose valid manifest `exports`.
  - React and Svelte packages each define `build`, `lint`, and `test` scripts.
  - Svelte component subpath exports resolve to shipped files and compile.
  - No drawfn adapter source file imports a non-canonical core package identifier.
- Test vectors: `TV-SURFACE-003`, `TV-SURFACE-004`
- Notes: Script success depends on a bootstrapped workspace install; the scripts themselves and package-local test surfaces are part of this requirement.

## Requirement

- ID: `SCENE-001`
- Priority: `P0`
- Statement: `Drawfn.load()` and `Drawfn.loadScene()` MUST normalize, validate, and preserve version `1` scenes deterministically, with tolerant loading only through the defined `DrawfnResult<Scene>` envelope.
- Rationale: The audit found raw cloning in `load()` and broken tolerant parsing in `loadScene()`.
- Acceptance criteria:
  - `load(scene)` deep-clones and normalizes a valid `Scene`.
  - `loadScene(sceneData)` returns `{ ok: true, data }` only for normalized version `1` scenes.
  - Invalid shape, unsupported version, and limit violations return `{ ok: false, error }` without mutating active scene state.
  - On successful load, selection and history reset deterministically.
- Test vectors: `TV-SCENE-001`, `TV-SCENE-002`
- Notes: Unknown fields outside `meta` are dropped during tolerant load.

## Requirement

- ID: `SCENE-002`
- Priority: `P0`
- Statement: Freedraw point storage, rendering, hit-testing, export, and tolerant legacy load MUST use a single canonical element-local coordinate basis.
- Rationale: Mixed absolute/relative freedraw points break serialization and visual correctness.
- Acceptance criteria:
  - Newly created freedraw strokes store `[0,0,...]` as the first point relative to element origin.
  - Renderer and SVG export interpret freedraw points in the same coordinate basis.
  - Known legacy corruption patterns are normalized when repairable.
  - Irreparable mixed-basis points fail deterministic validation.
- Test vectors: `TV-SCENE-003`, `TV-SCENE-004`
- Notes: This requirement applies only to freedraw; node-related scene data remains out of scope.

## Requirement

- ID: `HISTORY-001`
- Priority: `P0`
- Statement: Gesture-driven scene edits MUST create at most one committed undo snapshot per gesture, while transient updates MUST NOT add independent history entries.
- Rationale: Current per-frame history spam makes undo/redo unusable for production drawing flows.
- Acceptance criteria:
  - A pen stroke creates one undo step.
  - A drag-move gesture creates one undo step.
  - A resize or rotation gesture creates one undo step.
  - Cancelled or no-op gestures create zero new undo steps.
- Test vectors: `TV-HISTORY-001`, `TV-HISTORY-002`
- Notes: Camera-only changes are excluded and MUST remain non-undoable in this bundle.

## Requirement

- ID: `EVENTS-001`
- Priority: `P0`
- Statement: Core MUST emit `selectionChanged`, `historyChanged`, `sceneChanged`, and existing element events consistently for all user-visible state changes covered by this spec.
- Rationale: Wrappers and hosts currently miss selection and scene transitions because event emission is incomplete.
- Acceptance criteria:
  - Pointer selection changes emit `selectionChanged`.
  - `clear`, `load`, `undo`, `redo`, reorder, camera changes, and text commits emit `sceneChanged`.
  - Content mutations continue to emit their element-specific events.
  - Recoverable failures emit `error`.
- Test vectors: `TV-EVENTS-001`, `TV-EVENTS-002`
- Notes: Selection-only changes MUST NOT emit `sceneChanged` because selection is not part of serialized `Scene`.

## Requirement

- ID: `INPUT-001`
- Priority: `P0`
- Statement: Select-tool hit-testing, marquee selection, drag, resize, rotate, and delete interactions MUST be deterministic, rotation-aware where specified, and robust to pointer completion outside the canvas.
- Rationale: The audit found center-point marquee heuristics, incomplete pointer completion, and selection event gaps.
- Acceptance criteria:
  - Marquee selection uses element bounds intersection instead of center-point-only selection.
  - Rotated elements use rotation-aware hit-testing for selection and handles.
  - Pointer release outside the canvas still commits or cancels the active gesture correctly.
  - Locked elements remain non-interactive.
- Test vectors: `TV-INPUT-001`, `TV-INPUT-002`
- Notes: This requirement applies to select/pan/shape/text/image tools and shared pointer plumbing.

## Requirement

- ID: `INPUT-002`
- Priority: `P0`
- Statement: Wheel zoom anchoring, space-to-pan, and destructive keyboard shortcuts MUST behave correctly and MUST only act in safe interaction contexts.
- Rationale: The audit found broken zoom anchoring and unsafe global shortcut handling.
- Acceptance criteria:
  - Wheel zoom keeps the pre-zoom canvas point under cursor invariant within tolerance.
  - Space temporarily switches to pan and restores the previous tool on release.
  - Delete/Backspace does not remove elements while text entry is active.
  - Keyboard shortcuts are ignored when the active target is not a drawfn interaction context.
- Test vectors: `TV-INPUT-003`, `TV-INPUT-004`
- Notes: Touch gestures beyond pointer event parity are Undefined in this bundle.

## Requirement

- ID: `TEXT-001`
- Priority: `P0`
- Statement: Text creation and re-edit flows MUST share the same overlay commit pipeline and MUST preserve scene, history, event, and cleanup correctness.
- Rationale: Current existing-text edits mutate scene state directly and bypass observable state transitions.
- Acceptance criteria:
  - Creating text opens an overlay tied to a provisional or target element.
  - Re-editing text routes updates through the same commit path as new text.
  - Empty new text removes the provisional element.
  - `destroy()` and blur cleanup remove overlays and event listeners reliably.
- Test vectors: `TV-TEXT-001`, `TV-TEXT-002`
- Notes: Text styling beyond the current font fields is out of scope.

## Requirement

- ID: `RENDER-001`
- Priority: `P0`
- Statement: The renderer MUST draw locked elements, use rotation-aware bounds for culling and selection visuals, and normalize selection chrome to zoom.
- Rationale: The current renderer hides locked elements and uses axis-aligned bounds in paths that require oriented bounds.
- Acceptance criteria:
  - Locked elements render with the same visual rules as unlocked elements.
  - Rotated elements are culled using oriented bounds.
  - Selection box and handles follow rotated geometry.
  - Handle sizes remain visually constant across zoom levels.
- Test vectors: `TV-RENDER-001`, `TV-RENDER-002`
- Notes: Multi-canvas caching remains out of scope.

## Requirement

- ID: `EXPORT-001`
- Priority: `P0`
- Statement: Runtime image loading and PNG/SVG export MUST share the same loader semantics, MUST trigger repaint on async image completion, and MUST fail deterministically for empty selection and export image failures.
- Rationale: The audit found missing rerenders and export paths that ignore the host image loader.
- Acceptance criteria:
  - Async image load completion triggers a repaint while the element is still present.
  - `exportPNG` uses the host loader when one is configured.
  - `selectedOnly: true` with no selected elements fails with `EXPORT_EMPTY_SELECTION`.
  - Export errors use the defined error codes and failure envelopes.
- Test vectors: `TV-EXPORT-001`, `TV-EXPORT-002`
- Notes: `fitContent` and `selectedOnly` MUST be documented for both export methods after this bundle.

## Requirement

- ID: `REACT-001`
- Priority: `P0`
- Statement: The React adapter MUST compile against the canonical core package, support controlled and uncontrolled scenes without reset loops, and source `onSceneChange` from `sceneChanged`.
- Rationale: The current React adapter imports the wrong package and reloads scenes in controlled mode in a way that resets runtime state.
- Acceptance criteria:
  - All React adapter imports reference `drawfn`.
  - `onSceneChange` fires for `load`, `clear`, content mutations, undo/redo, reorder, and camera changes.
  - Echoing an externally supplied scene back into the component without semantic differences does not call `load()` again.
  - React package defines and passes build/lint/test commands.
- Test vectors: `TV-REACT-001`, `TV-REACT-002`
- Notes: The existing prop names and hook names MUST remain stable.

## Requirement

- ID: `SVELTE-001`
- Priority: `P0`
- Statement: The Svelte action, components, stores, and package exports MUST compile against the canonical core package, support controlled and uncontrolled scenes without reset loops, and remain internally type-safe.
- Rationale: The current Svelte adapter has both compile-surface and controlled-mode issues.
- Acceptance criteria:
  - All Svelte adapter imports reference `drawfn`.
  - `Canvas.svelte` and `DrawfnCanvas.svelte` compile without invalid bindings.
  - Action/component `onSceneChange` callbacks source from `sceneChanged`.
  - Store state updates for `elementCount`, `camera`, `canUndo`, `canRedo`, and selection remain in sync and unsubscribe correctly.
- Test vectors: `TV-SVELTE-001`, `TV-SVELTE-002`
- Notes: Public prop names and exported helper names MUST remain stable.

## Requirement

- ID: `OBS-001`
- Priority: `P1`
- Statement: Recoverable runtime failures covered by this spec MUST surface through result envelopes, error events, or rejected export promises, and MUST NOT rely on `console.*` side effects.
- Rationale: Console-only recoverable errors are not production-grade observability.
- Acceptance criteria:
  - `loadScene` returns `DrawfnResult<Scene>` without console logging.
  - Export/image failures emit `error` and reject or return structured failure info as specified.
  - Core code paths covered by this spec contain no required runtime dependence on `console.log`, `console.warn`, or `console.error`.
- Test vectors: `TV-OBS-001`, `TV-OBS-002`
- Notes: Throwing for unrecoverable constructor failures such as missing 2D context remains allowed.

## Requirement

- ID: `QA-001`
- Priority: `P0`
- Statement: The drawfn packages MUST ship a repo-root verification gate consisting of package-local tests, builds, lint/typecheck, and smoke-level docs/examples that cover the fixed behavior in this bundle.
- Rationale: Production readiness requires repeatable evidence, not only code inspection.
- Acceptance criteria:
  - Core package has tests for scene validation, history boundaries, event emission, input invariants, and export/image behavior.
  - React and Svelte packages each have at least one automated smoke test or compile test and a `test` script.
  - README/example content aligns with the canonical package surface and fixed APIs.
  - Verification commands in `PLAN.md` and phase files run from `repo root`.
- Test vectors: `TV-QA-001`, `TV-QA-002`
- Notes: CI configuration changes are optional; local repo-root verification is mandatory.

