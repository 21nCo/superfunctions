# Phase Completion Report

## Metadata

- Timestamp: `2026-03-25T16:25:18Z`
- agent_name: `unknown-agent`
- model: `GPT-5 Codex`
- launcher: `Codex Desktop`
- workspace/project absolute path: `/Users/serro/.codex/worktrees/0909/superfunctions/docsfn`
- OS + shell: `Darwin ArBook.local 25.3.0 arm64`, `/bin/zsh`
- repo metadata:
  - repo root: `/Users/serro/.codex/worktrees/0909/superfunctions`
  - branch: `HEAD` (detached)
  - commit: `ca86e25e6faf11da93e390c18dad8ae5f22b6f69`
  - dirty worktree: `yes`

## Phase

- `PHASE_01`

## Status

- `PASS`

## Requirements Summary

- Requirements delivered:
  - `CFG-001`
  - `CONTENT-001`
  - `API-001`
  - `SEARCH-001`

### `CFG-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - `docsfn/core/src/types.ts` and `docsfn/core/src/config.ts` expose and validate `search.routeScopeOverrides`.
  - `docsfn/core/src/search.ts` validates override patterns and scope values before build output is returned, including the `enabled: false` path.
  - `docsfn/core/src/search.test.ts` proves deterministic artifact equality and validates invalid override patterns, invalid scope values, and ambiguous effective matches with `DOCS_SEARCH_SCOPE_INVALID`.
  - Canonical fixture coverage in `docsfn/core/src/search.test.ts` proves `/docs` and representative fixture routes remain unchanged when `/docs/api/**` overrides do not match.
- Test status:
  - `npm --prefix docsfn/core run test -- --run src/compile.test.ts src/search.test.ts src/search-runtime.test.ts` -> `PASS` (`27` tests)
  - `npm --prefix docsfn/core run test -- --run src/search.test.ts -t "keeps canonical fixture search routes stable"` -> `PASS` (`2` targeted fixture tests)

### `CONTENT-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - `docsfn/core/src/types.ts` finalizes compiled-content v2:
    - `CompiledContentArtifact.renderModelVersion: 2`
    - `CompiledTabsBlock.tabs[*].nodes`
    - `CompiledComponentBlock.children`
    - explicit `mermaid` blocks with stable `id`
  - `docsfn/core/src/markdown.ts` now emits nested compiled child blocks for tabs and components, stable mermaid ids, and unresolved-component failures instead of raw fallback.
  - `docsfn/core/src/compat/fumadocs.ts` lets unresolved JSX tags flow into the resolver path so unsupported syntax and unresolved components are distinguished correctly.
  - `docsfn/core/src/compile.test.ts` proves:
    - tabs compile to nested nodes
    - component blocks preserve normalized props and compiled children
    - mermaid fences compile to explicit mermaid blocks with stable ids
    - unsupported constructs fail with `DOCS_COMPAT_UNSUPPORTED`
    - unresolved components fail with `DOCS_COMPONENT_UNRESOLVED`
- Test status:
  - `npm --prefix docsfn/core run test -- --run src/compile.test.ts src/search.test.ts src/search-runtime.test.ts` -> `PASS`

### `API-001`

- Status: `PARTIAL`
- Acceptance criteria evidence:
  - `docsfn/core/src/search.ts` reclassifies hand-written docs pages into `api` search scope through `search.routeScopeOverrides` without changing routes.
  - `docsfn/core/src/search.test.ts` proves `/docs/api/client` remains at `/docs/api/client` while moving into `api` scope.
  - Canonical fixture coverage proves the override system is classification-only when no configured routes match.
- Test status:
  - `npm --prefix docsfn/core run test -- --run src/compile.test.ts src/search.test.ts src/search-runtime.test.ts` -> `PASS`
- Remaining acceptance work:
  - Dogfood-site and guide-level consistency for the chosen API model is assigned to later phases (`PHASE_04+`) in the revised spec.

### `SEARCH-001`

- Status: `PARTIAL`
- Acceptance criteria evidence:
  - `docsfn/core/src/search.ts` now uses `routeScopeOverrides` with fail-closed validation and deterministic matching.
  - `docsfn/core/src/search-runtime.ts` now hydrates search artifacts through `@searchfn/client`’s `InMemorySearchFn` + `importSnapshot(...)`, not legacy bare `searchfn` exports.
  - `searchfn/client/src/in-memory-search.ts` and `searchfn/client/src/index.ts` provide the canonical in-memory hydration/query surface consumed by docsfn.
  - `docsfn/core/src/search.test.ts` proves:
    - deterministic search artifacts
    - route reclassification into `api`
    - ambiguity failures with `DOCS_SEARCH_SCOPE_INVALID`
    - invalid override pattern failures
    - canonical fixture route stability under non-matching overrides
  - `docsfn/core/src/search-runtime.test.ts` proves snapshot hydration and scope-filtered querying through the current `@searchfn/*` runtime surface.
- Test status:
  - `npm --prefix docsfn/core run test -- --run src/compile.test.ts src/search.test.ts src/search-runtime.test.ts` -> `PASS`
  - `npm --prefix searchfn/client run test -- --run __tests__/in-memory-search.test.ts __tests__/constructors.test.ts __tests__/legacy-guard.test.ts` -> `PASS` (`11` tests)
  - `npm --prefix searchfn/client run build` -> `PASS`
- Remaining acceptance work:
  - Search UI behavior (`Cmd/Ctrl+K`, scope-filter UX, keyboard selection, cacheable endpoint wiring in shipped apps) belongs to later phases.

## Deliverables Summary

- Files changed/added:
  - `docsfn/core/package.json`
  - `docsfn/core/src/browser.ts`
  - `docsfn/core/src/compat/fumadocs.ts`
  - `docsfn/core/src/compile.test.ts`
  - `docsfn/core/src/compile/react.ts`
  - `docsfn/core/src/compile/svelte.ts`
  - `docsfn/core/src/config.ts`
  - `docsfn/core/src/diagnostics.ts`
  - `docsfn/core/src/index.ts`
  - `docsfn/core/src/markdown.ts`
  - `docsfn/core/src/search-runtime.ts`
  - `docsfn/core/src/search.test.ts`
  - `docsfn/core/src/search.ts`
  - `docsfn/core/src/types.ts`
  - `docsfn/core/tsconfig.json`
  - `docsfn/core/vitest.config.ts`
  - `searchfn/client/__tests__/in-memory-search.test.ts`
  - `searchfn/client/__tests__/legacy-guard.test.ts`
  - `searchfn/client/package.json`
  - `searchfn/client/src/in-memory-search.ts`
  - `searchfn/client/src/index.ts`
  - `searchfn/client/tsconfig.json`
  - `searchfn/client/vitest.config.ts`
  - `package-lock.json`
- Files deleted/modified:
  - No phase-owned source files remain deleted in the final state.

## Verification Summary

- Phase verification steps executed:
  - `npm --prefix docsfn/core run test -- --run src/compile.test.ts src/search.test.ts src/search-runtime.test.ts` -> `PASS`
  - `npm --prefix searchfn/client run test -- --run __tests__/in-memory-search.test.ts __tests__/constructors.test.ts __tests__/legacy-guard.test.ts` -> `PASS`
  - `npm --prefix docsfn/core run test -- --run src/search.test.ts -t "keeps canonical fixture search routes stable"` -> `PASS`
- Additional verification executed:
  - `npm ci` -> `PASS`
  - `npm --prefix searchfn/client run build` -> `PASS`
  - `git diff --check` -> `PASS`
- Test execution results:
  - `docsfn/core` focused suite: `3` files passed, `27` tests passed
  - `searchfn/client` focused suite: `3` files passed, `11` tests passed
  - canonical fixture search stability suite: `1` file passed, `2` targeted tests passed

## Notes

- Finalized compiled-content v2 shape:
  - `CompiledContentArtifact.renderModelVersion = 2`
  - `CompiledTabsBlock.tabs[*] = { value, label?, source, content, nodes }`
  - `CompiledComponentBlock = { type, name, props, source, body?, selfClosing, children }`
  - `CompiledMermaidBlock = { type: "mermaid", id, code }`
- Stable mermaid ids are path-based and deterministic, e.g. `mermaid-content/docs/routes-mdx-01`.
- Exact search scope resolution order implemented in `resolveSearchScopeForRoute(...)`:
  1. Normalize the route to leading-slash, no-trailing-slash form.
  2. Normalize overrides and lexicographically sort them by pattern.
  3. Collect every override whose glob-derived regex matches the normalized route.
  4. If nothing matches, default by kind: `page -> docs`, `api -> api`, `post -> blog`.
  5. If all matches agree, use that scope.
  6. If matches disagree, throw `DOCS_SEARCH_SCOPE_INVALID`.
- New diagnostics exercised in this phase:
  - invalid override pattern -> `DOCS_SEARCH_SCOPE_INVALID`
  - invalid override scope -> `DOCS_SEARCH_SCOPE_INVALID`
  - ambiguous effective override set -> `DOCS_SEARCH_SCOPE_INVALID`
  - unsupported compat construct -> `DOCS_COMPAT_UNSUPPORTED`
  - unresolved component -> `DOCS_COMPONENT_UNRESOLVED`
- Finalized searchfn integration surface used by docsfn:
  - `@searchfn/client` export `InMemorySearchFn`
  - `@searchfn/client` export type `InMemorySearchFnSnapshot`
  - build path: docsfn indexes documents into `InMemorySearchFn` and serializes with `exportSnapshot()`
  - runtime path: docsfn hydrates with `importSnapshot()` and queries via `searchDetailed(...)`
- Canonical fixture search coverage now proves route paths remain unchanged for `searchfn-docs` and `datafn-docs` when `/docs/api/**` overrides do not match.
- The previous `PHASE_01-2026-03-25-m3n8q1-report.md` is superseded by this report because it was written before workspace bootstrap and before the revised searchfn integration strategy was fully verified.
- `PHASE_01` is not the final phase of the spec, so `.conduct/tracker.csv` was intentionally not modified.

## Ready For Next Phase?

- `Yes` — revised `PHASE_01` verification passed, the canonical `@searchfn/*` search runtime surface is now wired into docsfn, and later search UI/dogfood alignment work remains in later phases by spec design.

## Blockers

- None for progressing to `PHASE_02`.
