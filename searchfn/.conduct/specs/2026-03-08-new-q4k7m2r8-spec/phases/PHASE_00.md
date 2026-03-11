# PHASE_00 — Extract @searchfn/core Package

## Phase Goal
Move all engine internals from `searchfn/client/src/` into a new `searchfn/core/` package so adapters can depend on core without pulling in adapter-specific code.

## In Scope
- Create `searchfn/core/` package structure with `package.json`, `tsconfig.json`, `tsup.config.ts`
- Move all pipeline, indexing, query, cache, storage, utils, compat, and type modules
- Update internal imports
- Re-export everything from `searchfn/core/src/index.ts`
- Retarget existing tests to new location

## Out of Scope
- Creating adapters (PHASE_01/02)
- Modifying any logic — this is a pure move/repackage
- Changing the @searchfn/client package exports (PHASE_06)

## Deliverables
- `searchfn/core/package.json` — `@searchfn/core` package
- `searchfn/core/tsconfig.json`
- `searchfn/core/tsup.config.ts`
- `searchfn/core/src/index.ts` — re-exports all modules
- `searchfn/core/src/pipeline/` — PipelineEngine, stages, stemmers, stop words, types
- `searchfn/core/src/indexing/` — Indexer, DocumentAccumulator
- `searchfn/core/src/query/` — QueryEngine, scoring, DocumentStatsManager, types
- `searchfn/core/src/cache/` — LruCache, types
- `searchfn/core/src/storage/` — IndexedDbManager, chunk-serializer, errors
- `searchfn/core/src/utils/` — levenshtein, logger, env
- `searchfn/core/src/compat/` — index-adapter, document-adapter, migration, types
- `searchfn/core/src/types.ts` — DocId, StoredPostingChunk, etc.
- `searchfn/core/src/config/defaults.ts`
- `searchfn/core/__tests__/` — migrated tests

## Requirements Covered
- CORE-004

## Implementation Tasks
1. Create `searchfn/core/` directory structure
2. Create `package.json` for `@searchfn/core` (version 0.1.0, type: module, same dev deps as current client)
3. Create `tsconfig.json` extending root or standalone
4. Create `tsup.config.ts` matching current client build config
5. Move `searchfn/client/src/pipeline/` → `searchfn/core/src/pipeline/`
6. Move `searchfn/client/src/indexing/` → `searchfn/core/src/indexing/`
7. Move `searchfn/client/src/query/` → `searchfn/core/src/query/`
8. Move `searchfn/client/src/cache/` → `searchfn/core/src/cache/`
9. Move `searchfn/client/src/storage/` → `searchfn/core/src/storage/`
10. Move `searchfn/client/src/utils/` → `searchfn/core/src/utils/`
11. Move `searchfn/client/src/compat/` → `searchfn/core/src/compat/`
12. Move `searchfn/client/src/types.ts` → `searchfn/core/src/types.ts`
13. Move `searchfn/client/src/config/` → `searchfn/core/src/config/`
14. Create `searchfn/core/src/index.ts` that re-exports all modules (matching current client index.ts minus SearchFn/InMemorySearchFn)
15. Update all internal imports in core to use relative paths
16. Move relevant tests from `searchfn/client/__tests__/` to `searchfn/core/__tests__/` (pipeline, lru-cache, levenshtein, scoring, indexer, chunk-serializer, migration, compat tests)
17. Create `searchfn/core/vitest.config.ts`
18. Verify TypeScript compilation: `cd searchfn/core && npx tsc --noEmit`
19. Run tests: `cd searchfn/core && npx vitest run`

## Verification Steps
1. `cd searchfn/core && npx tsc --noEmit` — compiles with no errors
2. `cd searchfn/core && npx vitest run` — all migrated tests pass
3. `import { PipelineEngine, Indexer, DocumentStatsManager, scorePostings, QueryEngine, LruCache, IndexedDbManager } from "./src/index"` — resolves in a test file
4. No circular dependency warnings during build

## Stop Condition
Core package compiles, all tests pass, all engine internals are accessible via `@searchfn/core` exports. Report test results and any import issues before proceeding to PHASE_01.
