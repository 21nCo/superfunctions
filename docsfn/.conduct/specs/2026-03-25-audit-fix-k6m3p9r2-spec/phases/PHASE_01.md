# PHASE_01

- Phase goal: Upgrade the core compiled-content and search-classification contracts so framework renderers can achieve real parity.

## In scope

- compiled-content v2 block model
- unresolved component semantics
- search route-scope override semantics
- adapter-based search runtime contract alignment

## Out of scope

- framework renderer implementation details
- docs site guide corrections
- example app rewrites

## Deliverables

- Modify `docsfn/core/src/types.ts`
- Modify `docsfn/core/src/markdown.ts`
- Modify `docsfn/core/src/compile/react.ts`
- Modify `docsfn/core/src/compile/svelte.ts`
- Modify `docsfn/core/src/search.ts`
- Modify `docsfn/core/src/search-runtime.ts`
- Modify `docsfn/core/src/index.ts`
- Modify `docsfn/core/src/browser.ts`
- Create or expand tests in `docsfn/core/src/compile.test.ts`
- Create or expand tests in `docsfn/core/src/search.test.ts`
- Create or expand tests in `docsfn/core/src/search-runtime.test.ts`
- If required to satisfy the current package contract, modify `searchfn/client/*` to expose the in-memory hydration surface docsfn needs through the current `@searchfn/*` package family instead of a docsfn-local duplicate

## Requirements covered

- `CFG-001`
- `CONTENT-001`
- `API-001`
- `SEARCH-001`

## Implementation tasks

1. Introduce `renderModelVersion: 2` and nested `nodes` / `children` structures for tabs and component blocks.
2. Add stable mermaid block ids.
3. Implement unresolved component failure behavior.
4. Extend search config with `routeScopeOverrides` and deterministic resolution order.
5. Align `docsfn` search runtime assumptions with the current `@searchfn/*` adapter/client model rather than legacy bare-package exports.
6. Add tests on canonical fixture pages for compiled structure, scope classification, and runtime hydration behavior.

## Verification steps

1. Run: `npm --prefix docsfn/core run test -- --run src/compile.test.ts src/search.test.ts src/search-runtime.test.ts`
   Expected outcome: tabs/components compile to nested nodes, API scope overrides classify routes correctly, unresolved constructs fail closed, and search runtime uses the current `@searchfn/*` package path.
2. If `searchfn/client` is modified in this phase, run focused `searchfn/client` tests for the added/changed in-memory runtime surface.
   Expected outcome: docsfn-required hydration/query behavior is provided by the canonical `searchfn` workspace package rather than a docsfn-local duplicate.
3. Run a focused manifest/search build against canonical fixtures.
   Expected outcome: route paths unchanged; search scope classification changes only where configured.

## Stop condition

- Report the finalized compiled-content v2 shapes.
- Report the exact search scope resolution order, new diagnostics, and the finalized searchfn integration surface used by docsfn.
