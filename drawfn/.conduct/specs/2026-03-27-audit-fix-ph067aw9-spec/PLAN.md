# Architecture sketch

## Modules and responsibilities

- `drawfn/core/src/drawfn.ts`
  - public API
  - scene mutation orchestration
  - event emission
  - history coordination
  - export entry points
- `drawfn/core/src/types.ts`
  - canonical public types and envelopes
- `drawfn/core/src/history.ts`
  - action-level history bookkeeping
- `drawfn/core/src/renderer.ts`
  - paint pipeline
  - image cache behavior
  - selection chrome
- `drawfn/core/src/geometry.ts` and `drawfn/core/src/utils.ts`
  - bounds, hit-testing, point transforms
- `drawfn/core/src/tools/*`
  - gesture-specific behavior using shared mutation semantics
- `drawfn/drawfn-react/src/*`
  - React hook/component wrappers sourced from canonical core events
- `drawfn/drawfn-svelte/src/*`
  - Svelte action/component/store wrappers sourced from canonical core events
- package docs/examples/manifests
  - publish surface, verification instructions, and smoke usage

# Dependency graph

1. Canonical package surface and manifest alignment MUST land before wrapper verification can be trusted.
2. Core scene normalization and error envelopes MUST exist before wrapper sync logic can use `sceneChanged` safely.
3. Gesture/history/event fixes MUST land before React/Svelte controlled-mode logic is validated.
4. Rendering/export fixes MUST land before release-gate tests and example verification are finalized.
5. Docs and release checks MUST be the final phase because they depend on the stabilized package surface.

# Phases overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `00` | Align package surface and scope boundaries | canonical names, scripts, docs baseline, scope freeze | package manifest/doc checks |
| `01` | Normalize scene loading and public envelopes | validated scene loading, canonical freedraw encoding, error/result types | core unit tests |
| `02` | Fix gesture history and selection/input semantics | action-level undo, consistent selection events, safe shortcuts, robust pointer completion | core interaction tests |
| `03` | Fix rendering, text lifecycle, and export/image behavior | rotation-aware render/cull, locked rendering, text commit correctness, export/image loader fixes | renderer/export tests |
| `04` | Repair React wrapper behavior | canonical imports, sceneChanged-driven sync, controlled-mode stability | React smoke tests |
| `05` | Repair Svelte wrapper behavior | compile-safe components/action/store, controlled-mode stability | Svelte compile/smoke tests |
| `06` | Finalize release gate | repo-root verification commands, aligned docs/examples, release checklist | full local gate |

# Definition of Done (global)

No phase is complete unless its listed verification steps pass from `repo root`.

