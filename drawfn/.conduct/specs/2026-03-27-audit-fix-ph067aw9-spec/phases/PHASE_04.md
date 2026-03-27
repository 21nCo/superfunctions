# Phase goal

Repair the React adapter so it uses canonical imports, stable controlled/uncontrolled semantics, and repo-root verification.

# In scope / Out of scope

## In scope

- React adapter imports/exports
- `useDrawfn` controlled/uncontrolled behavior
- `DrawfnCanvas` readiness callback behavior
- React adapter smoke tests

## Out of scope

- Svelte adapter
- core runtime behavior outside wrapper integration points

# Deliverables

- `drawfn/drawfn-react/package.json`
- `drawfn/drawfn-react/src/use-drawfn.ts`
- `drawfn/drawfn-react/src/DrawfnCanvas.tsx`
- `drawfn/drawfn-react/src/index.ts`
- `drawfn/drawfn-react/src/__tests__/use-drawfn.test.tsx`
- `drawfn/drawfn-react/src/__tests__/drawfn-canvas.test.tsx`

# Requirements covered

- `SURFACE-002`
- `REACT-001`
- `QA-001`

# Implementation tasks

- [ ] Update React imports/re-exports to the canonical core package name.
- [ ] Source `onSceneChange` from `sceneChanged` rather than element-only events.
- [ ] Prevent deep-equal controlled scene echoes from reloading and clearing history/selection.
- [ ] Preserve existing public hook/component names and prop names.
- [ ] Add React smoke tests for mount, onReady, controlled echo suppression, and camera/undo/redo callback propagation.
- [ ] Add/verify `test` script and required test deps in package manifest.

# Verification steps

- `npm -w @drawfn/react run test -- --run`
  - Expected: React smoke tests pass.
- `npm -w @drawfn/react run lint`
  - Expected: hook/component typings remain valid.
- `npm -w @drawfn/react run build`
  - Expected: React adapter builds with canonical imports.

# Stop condition

Report the controlled-mode equality strategy and the exact wrapper callback sources before starting Phase 05.

