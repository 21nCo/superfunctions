# Phase goal

Fix gesture history granularity, selection event semantics, and safe input handling for core interactions.

# In scope / Out of scope

## In scope

- action-scoped history bookkeeping
- selection emission correctness
- marquee intersection semantics
- pointer capture/global pointer completion
- wheel zoom anchoring
- safe shortcut contexts

## Out of scope

- text overlay implementation details
- image/export fixes
- wrapper code

# Deliverables

- `drawfn/core/src/drawfn.ts`
- `drawfn/core/src/history.ts`
- `drawfn/core/src/tools/select-tool.ts`
- `drawfn/core/src/tools/pan-tool.ts`
- `drawfn/core/src/tools/pen-tool.ts`
- `drawfn/core/src/tools/rectangle-tool.ts`
- `drawfn/core/src/tools/ellipse-tool.ts`
- `drawfn/core/src/tools/arrow-tool.ts`
- `drawfn/core/src/tools/base-tool.ts`
- `drawfn/core/src/tools/tool-manager.ts`
- `drawfn/core/__tests__/interaction-history.test.ts`
- `drawfn/core/__tests__/selection-events.test.ts`
- `drawfn/core/__tests__/camera-input.test.ts`

# Requirements covered

- `HISTORY-001`
- `EVENTS-001`
- `INPUT-001`
- `INPUT-002`

# Implementation tasks

- [ ] Introduce an internal gesture transaction pattern so tools can begin, preview, commit, or cancel mutations without per-frame history spam.
- [ ] Route all selection changes through a single emission path.
- [ ] Replace center-point-only marquee selection with bounds intersection.
- [ ] Ensure rotated elements use the intended hit-testing path in select mode.
- [ ] Add pointer capture or equivalent window-level completion handling for active gestures.
- [ ] Fix wheel zoom anchoring math using stable screen/canvas transform invariants.
- [ ] Guard destructive shortcuts while editing text or when focus is outside drawfn interaction context.
- [ ] Add unit tests for history depth, selection event emission, marquee selection, off-canvas completion, and zoom invariance.

# Verification steps

- `npm -w drawfn run test -- --run interaction-history.test.ts selection-events.test.ts camera-input.test.ts`
  - Expected: interaction invariants and event ordering tests pass.
- `npm -w drawfn run lint`
  - Expected: internal tool contracts and event payloads typecheck.

# Stop condition

Report the internal history/gesture mechanism, the final `sceneChanged` emission rules, and the verified zoom-anchor invariant before starting Phase 03.

