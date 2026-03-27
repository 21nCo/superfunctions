# Phase goal

Repair the Svelte adapter so the action, components, and store compile cleanly and stay synchronized with core scene events.

# In scope / Out of scope

## In scope

- canonical imports
- `Canvas.svelte` and `DrawfnCanvas.svelte` compile correctness
- `drawfn` action update/destroy semantics
- store synchronization and cleanup
- Svelte compile/smoke tests

## Out of scope

- React adapter
- core runtime behavior outside wrapper integration points

# Deliverables

- `drawfn/drawfn-svelte/package.json`
- `drawfn/drawfn-svelte/src/index.ts`
- `drawfn/drawfn-svelte/src/drawfn-action.ts`
- `drawfn/drawfn-svelte/src/stores.ts`
- `drawfn/drawfn-svelte/src/Canvas.svelte`
- `drawfn/drawfn-svelte/src/DrawfnCanvas.svelte`
- `drawfn/drawfn-svelte/src/__tests__/drawfn-action.test.ts`
- `drawfn/drawfn-svelte/src/__tests__/drawfn-canvas.test.ts`

# Requirements covered

- `SURFACE-002`
- `SVELTE-001`
- `QA-001`

# Implementation tasks

- [ ] Update Svelte imports/re-exports to the canonical core package name.
- [ ] Remove or replace invalid internal child binding patterns so `Canvas.svelte` and `DrawfnCanvas.svelte` compile.
- [ ] Source action/component `onSceneChange` from `sceneChanged`.
- [ ] Keep store `elementCount`, `camera`, `canUndo`, `canRedo`, and selection synchronized and unsubscribe safely.
- [ ] Prevent deep-equal controlled scene echoes from reloading and clearing history/selection.
- [ ] Add Svelte compile/smoke tests and a package-local `test` script.

# Verification steps

- `npm -w @drawfn/svelte run test -- --run`
  - Expected: Svelte compile/smoke tests pass.
- `npm -w @drawfn/svelte run lint`
  - Expected: Svelte adapter typings remain valid.
- `npm -w @drawfn/svelte run build`
  - Expected: Svelte adapter package builds and exports the declared subpaths.

# Stop condition

Report the final `Canvas.svelte` public contract and the store synchronization event sources before starting Phase 06.

