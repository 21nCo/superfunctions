# PLAN

## Architecture Sketch

### Module layout

- `docsfn/core`
  - `src/types.ts`: compiled-content v2, search override config, release summary types
  - `src/markdown.ts` and `src/compile/*`: structured tab/component child compilation and fail-closed component semantics
  - `src/search.ts`: truthful search scope assignment, deterministic search docs, and deterministic artifact serialization
  - `src/search-runtime.ts`: adapter/client-backed runtime hydration over the deterministic docsfn search artifact
  - `src/browser.ts` / `src/index.ts`: browser-safe shared exports including compiled-content cache helpers
- `searchfn/client`
  - current canonical search runtime surface for ephemeral/in-memory query behavior needed by docsfn
  - any docsfn-required in-memory hydration helper MUST live here instead of being duplicated in docsfn
- `docsfn/react`
  - `src/DocsContent.tsx`: recursive tabs/components and mermaid render contract
  - tests for content, blog, embedded, search parity
- `docsfn/svelte`
  - `src/DocsContent.svelte`: recursive tabs/components and mermaid render contract
  - `package.json` exports map for public component subpaths
  - tests for content, blog, embedded, search parity
- `docsfn/next`
  - helper compatibility with compiled-content caches and example proof routes
- `docsfn/sveltekit`
  - helper compatibility with compiled-content caches and example proof routes
- `docsfn/docs`
  - dogfood config, API search scope alignment, guide correctness, compiled-content caching
- `docsfn/examples`
  - proof-route implementations that use shipped framework layers
- `docsfn/scripts`
  - release preflight
  - docs contract check
  - release gate and migration parity hardening

## Dependency Graph

1. Contract and proof requirements MUST be frozen before renderer work starts.
2. Core compiled-content model changes MUST land before React or Svelte renderer refactors.
3. Search/API scope semantics and searchfn runtime alignment MUST land before dogfood/docs and examples can be finalized.
4. Package export fixes MUST land before docs/guides are corrected.
5. Example conversions MUST land before release-gate hardening.
6. Release-gate hardening MUST land before final production verification.

## Phases Overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `00` | Freeze the acceptance contract and bootstrap preflight | failing parity harness, docs contract checks, release env checks | local failing/green proof scripts |
| `01` | Upgrade core compiled-content and classification semantics | structured tabs/components, mermaid ids, search scope overrides, adapter-based search runtime contract | core unit tests on canonical fixtures |
| `02` | Restore React/Next parity | React renderer + Next proof routes | React component tests + Next proof routes |
| `03` | Restore Svelte/SvelteKit parity and public exports | Svelte renderer, exports map, browser-safe imports | Svelte component tests + export/import checks |
| `04` | Make dogfood site truthful | docs site search/API model alignment and compiled-content caching | dogfood route/load tests |
| `05` | Make public docs truthful | README/guide/API ref alignment and docs contract pass | docs contract check |
| `06` | Convert example apps into real proofs | shipped-component rendering for docs/api/blog/embedded routes | example integration/e2e checks |
| `07` | Harden release gate and final verification | deterministic release summary, full matrix, clean-checkout bootstrap | full release gate passes |

## Definition Of Done

No phase is complete unless its verification steps pass.

Global Definition of Done:

1. All requirement IDs assigned to the phase are implemented.
2. The phase verification steps run locally without CI-only dependencies.
3. No proof route for a required surface renders raw source fallback.
4. `docsfn/docs`, both example apps, and the release gate agree on the same public import and route/content model.
5. `docsfn` search build/runtime behavior uses the current `@searchfn/*` adapter/client architecture rather than legacy bare-package exports.
