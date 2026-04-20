# Architecture Sketch

The examples bundle is organized into five layers:

1. Root workspace integration
   - Root `package.json` workspace glob and `verify:uifn-examples` script
2. Example hub
   - `uifn/examples/README.md`
   - `uifn/examples/package.json`
   - `uifn/examples/scripts/verify.mjs`
3. Shared example data
   - `uifn/examples/shared/src/scenarios.ts`
   - `uifn/examples/shared/src/capabilities.ts`
   - `uifn/examples/shared/src/fixtures.ts`
   - `uifn/examples/shared/src/index.ts`
4. Framework playgrounds
   - `uifn/examples/react-playground/*`
   - `uifn/examples/svelte-playground/*`
   - `uifn/examples/vue-playground/*`
5. Documentation and verification linkage
   - `uifn/README.md`
   - `uifn/react/README.md`
   - `uifn/svelte/README.md`
   - `uifn/vue/README.md`

# Dependency Graph

```text
PHASE_00 workspace + hub scaffolding
  -> PHASE_01 shared scenarios + fixtures + capability metadata
    -> PHASE_02 React playground
    -> PHASE_03 Svelte playground
      -> PHASE_04 Vue playground + unsupported-state handling
        -> PHASE_05 docs integration + verify:uifn-examples + offline/a11y smoke
```

# Phases Overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `PHASE_00` | Establish workspace and command contract | Nested workspaces, private example hub, root verify entry point scaffold | workspace discovery and script presence checks |
| `PHASE_01` | Create shared example foundation | Canonical scenarios, capability matrix, deterministic fixtures | shared package build/import smoke and registry snapshot review |
| `PHASE_02` | Ship React canonical playground | React Vite app with all four scenarios and `VirtualizedList` | React build plus manual route smoke |
| `PHASE_03` | Ship Svelte canonical playground | Svelte Vite app with all four scenarios and `VirtualizedList` | Svelte build plus manual route smoke |
| `PHASE_04` | Ship truthful Vue playground | Vue Vite app with three supported scenarios and unsupported `virtualized-results` handling | Vue build plus unsupported-route smoke |
| `PHASE_05` | Wire documentation and verification | README links, canonical verify JSON, offline scan, final root command | `npm run verify:uifn-examples` and README review |

# Definition Of Done

No phase is complete unless its verification steps pass locally, and the overall bundle is not complete until `npm run verify:uifn-examples` succeeds and the docs truthfully point users to the new examples.
