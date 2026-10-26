# Phase goal

Implement deterministic scene validation/loading and canonical freedraw data semantics.

# In scope / Out of scope

## In scope

- `DrawfnResult` / `DrawfnError` public types
- `load(scene)` normalization
- `loadScene(sceneData)` tolerant validation
- canonical freedraw point encoding
- caps enforcement relevant to scene validation

## Out of scope

- wrapper logic
- export/image runtime fixes
- node/Nucleus behavior changes

# Deliverables

- `drawfn/core/src/types.ts`
- `drawfn/core/src/drawfn.ts`
- `drawfn/core/src/utils.ts`
- `drawfn/core/src/geometry.ts`
- `drawfn/core/src/index.ts`
- `drawfn/core/__tests__/scene-load.test.ts`
- `drawfn/core/__tests__/freedraw-normalization.test.ts`

# Requirements covered

- `SCENE-001`
- `SCENE-002`
- `OBS-001`

# Implementation tasks

- [ ] Add canonical public error/result envelope types.
- [ ] Define strict normalization rules for `Scene`, `Camera`, `Background`, and `Element`.
- [ ] Make `load(scene)` normalize valid scenes rather than raw-clone them.
- [ ] Make `loadScene(sceneData)` validate unknown input and return `DrawfnResult<Scene>`.
- [ ] Implement canonical freedraw point encoding for newly created strokes.
- [ ] Add tolerant normalization for the known legacy freedraw corruption pattern.
- [ ] Reject irreparable scene data with deterministic error codes.
- [ ] Add unit tests for success, invalid version, invalid shape, cap violation, and freedraw normalization cases.

# Verification steps

- `npm -w drawfn run test -- --run scene-load.test.ts freedraw-normalization.test.ts`
  - Expected: all scene validation and freedraw normalization tests pass.
- `npm -w drawfn run lint`
  - Expected: new public types and load signatures typecheck.

# Stop condition

Report the finalized `DrawfnErrorCode` list, the `loadScene()` result shape, and the exact legacy freedraw normalization rule before starting Phase 02.

