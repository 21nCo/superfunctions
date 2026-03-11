# PHASE_01 — SearchAdapter Interface + Memory Adapter

## Phase Goal
Define the universal `SearchAdapter` interface and implement the `MemoryAdapter` using core internals.

## In Scope
- `SearchAdapter` interface definition in `@searchfn/adapters`
- `MemoryAdapter` class implementing full-text search in memory
- `searchAll()` on MemoryAdapter
- `fieldBoosts` support
- `fuzzy` support via core's levenshtein
- Package setup for `@searchfn/adapters`
- Comprehensive tests

## Out of Scope
- IndexedDB adapter (PHASE_02)
- External adapter stubs (PHASE_06)
- DataFn integration (PHASE_03-05)

## Deliverables
- `searchfn/adapters/package.json` — `@searchfn/adapters`
- `searchfn/adapters/tsconfig.json`
- `searchfn/adapters/tsup.config.ts`
- `searchfn/adapters/src/types.ts` — `SearchAdapter` interface, `SearchAdapterConfig`
- `searchfn/adapters/src/memory.ts` — `MemoryAdapter` class
- `searchfn/adapters/src/index.ts` — re-exports
- `searchfn/adapters/__tests__/memory.test.ts` — comprehensive tests
- `searchfn/adapters/__tests__/adapter-contract.test.ts` — shared contract tests (reusable for other adapters)

## Requirements Covered
- CORE-001, CORE-002, CORE-005, CORE-006, CORE-007, CORE-008, CORE-009, CORE-010

## Implementation Tasks
1. Create `searchfn/adapters/` directory structure
2. Create `package.json` for `@searchfn/adapters` with `@searchfn/core` as dependency
3. Create `tsconfig.json` and `tsup.config.ts`
4. Define `SearchAdapter` interface in `src/types.ts`:
   - `name: string` (readonly)
   - `index(params)`, `search(params)`, `remove(params)`, `clear(resource)`
   - Optional: `searchAll(params)`, `initialize(config)`, `dispose()`
   - Export `DocId` re-export from core
5. Implement `MemoryAdapter` in `src/memory.ts`:
   - Maintain `Map<string, ResourceEngine>` where each `ResourceEngine` holds pipeline, indexer, stats, postings per resource
   - `index()`: ingest documents using `PipelineEngine` + `Indexer`, store postings in memory (migrate logic from `InMemorySearchFn.add()`)
   - `search()`: build query tokens, retrieve postings, score with `scorePostings()`, apply fieldBoosts as score multiplier, apply fuzzy expansion (migrate logic from `InMemorySearchFn.executeSearch()`)
   - `remove()`: remove from postings and stats (migrate from `InMemorySearchFn.remove()`)
   - `clear()`: reset resource engine
   - `searchAll()`: iterate all resources or specified subset, search each, merge by score
   - `initialize()`: pre-create resource engines with field config
   - `dispose()`: clear all state
6. Create `src/index.ts` exporting `SearchAdapter`, `MemoryAdapter`, types
7. Write contract tests in `__tests__/adapter-contract.test.ts` (reusable test suite):
   - Basic index + search (TV-MEM-001)
   - Empty results (TV-MEM-002)
   - Remove (TV-MEM-003)
   - Clear (TV-MEM-004)
   - Field restriction (TV-MEM-005)
   - Upsert (TV-UPS-001, TV-UPS-002)
   - Resource isolation (TV-ISO-001, TV-ISO-002)
   - Lifecycle (TV-LIFE-001, TV-LIFE-002)
8. Write MemoryAdapter-specific tests in `__tests__/memory.test.ts`:
   - Fuzzy search (TV-FUZZ-001, TV-FUZZ-002)
   - Field boosts (TV-BOOST-001)
   - searchAll (TV-XSRC-001, TV-XSRC-002, TV-XSRC-003)
   - searchAll with MEM-006 fuzzy combo
9. Create `vitest.config.ts`
10. Verify TypeScript compilation and tests

## Verification Steps
1. `cd searchfn/adapters && npx tsc --noEmit` — no errors
2. `cd searchfn/adapters && npx vitest run` — all tests pass
3. Contract tests pass for MemoryAdapter
4. TV-MEM-001 through TV-MEM-007 pass
5. TV-ISO-001, TV-ISO-002 pass
6. TV-UPS-001, TV-UPS-002 pass
7. TV-XSRC-001 through TV-XSRC-003 pass
8. TV-BOOST-001 pass
9. TV-FUZZ-001, TV-FUZZ-002 pass

## Stop Condition
`SearchAdapter` interface defined, `MemoryAdapter` fully implemented and tested. All contract tests pass. Report test count and any design decisions made before proceeding to PHASE_02.
