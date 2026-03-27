# Phase goal

Fix text overlay lifecycle, rendering correctness, and image/export behavior in the core package.

# In scope / Out of scope

## In scope

- text create/re-edit commit path
- overlay cleanup
- locked-element rendering
- rotation-aware culling and selection chrome
- async image rerender
- export loader propagation and error semantics

## Out of scope

- wrapper code
- package surface/docs alignment already handled in Phase 00
- node/Nucleus behavior changes

# Deliverables

- `drawfn/core/src/drawfn.ts`
- `drawfn/core/src/renderer.ts`
- `drawfn/core/src/geometry.ts`
- `drawfn/core/src/tools/text-tool.ts`
- `drawfn/core/__tests__/text-editing.test.ts`
- `drawfn/core/__tests__/renderer-rotation.test.ts`
- `drawfn/core/__tests__/export-image.test.ts`

# Requirements covered

- `TEXT-001`
- `RENDER-001`
- `EXPORT-001`
- `OBS-001`

# Implementation tasks

- [ ] Rework existing-text edit to use the same commit/update path as new text creation.
- [ ] Ensure empty provisional text removes the provisional element and cleans up overlay state.
- [ ] Ensure `destroy()` removes active overlays and related listeners.
- [ ] Render locked elements while excluding them from interaction paths.
- [ ] Switch culling and selection visuals to rotation-aware bounds where required.
- [ ] Trigger redraw after async image load completion when the image still exists.
- [ ] Propagate host image loaders into export renderers.
- [ ] Reject empty-selection export and image-loader export failures with structured errors.
- [ ] Add unit tests for text commit/re-edit, locked rendering, rotated selection visuals, and export/image loader behavior.

# Verification steps

- `npm -w drawfn run test -- --run text-editing.test.ts renderer-rotation.test.ts export-image.test.ts`
  - Expected: text, render, and export/image tests pass.
- `npm -w drawfn run build`
  - Expected: dist output builds successfully after core API/runtime changes.

# Stop condition

Report the final export option semantics, error codes used by export failures, and the text overlay cleanup guarantees before starting Phase 04.

