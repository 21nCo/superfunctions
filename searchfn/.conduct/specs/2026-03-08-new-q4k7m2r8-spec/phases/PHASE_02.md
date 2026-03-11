# PHASE_02 — IndexedDB Adapter

## Phase Goal
Implement the `IndexedDbAdapter` using core's `IndexedDbManager`, `QueryEngine`, and `LruCache` for persistent browser-side search.

## In Scope
- `IndexedDbAdapter` class implementing `SearchAdapter`
- Persistent storage via IndexedDB
- LRU caching for term lookups
- `searchAll()` across resources
- Bulk indexing support
- Tests using `fake-indexeddb`

## Out of Scope
- Memory adapter (done in PHASE_01)
- DataFn integration (PHASE_03-05)
- Worker/SharedWorker support (existing pattern, not adapter concern)

## Deliverables
- `searchfn/adapters/src/indexeddb.ts` — `IndexedDbAdapter` class
- `searchfn/adapters/__tests__/indexeddb.test.ts` — tests
- Updated `searchfn/adapters/src/index.ts` — add IndexedDbAdapter export

## Requirements Covered
- CORE-003, CORE-005, CORE-006, CORE-007, CORE-008

## Implementation Tasks
1. Implement `IndexedDbAdapter` in `src/indexeddb.ts`:
   - Constructor accepts `IndexedDbAdapterOptions` (dbName, pipeline options)
   - Maintain `Map<string, { dbManager, queryEngine, statsManager, termCache, vectorCache, pipeline, indexer }>` per resource
   - `initialize()`: open IndexedDB databases per resource (or one DB with per-resource stores)
   - Lazy initialization: if `initialize()` not called, first `index()`/`search()` triggers it
   - `index()`:
     - Ingest documents via `Indexer`
     - Persist postings via `IndexedDbManager.putTermChunksBatch()`
     - Update document stats
     - Use existing `SearchFn` serialization logic (delta-varint encoding)
   - `search()`:
     - Build query tokens via pipeline
     - Retrieve postings via `QueryEngine` (with LRU cache)
     - Score and return sorted DocId[]
   - `remove()`:
     - Delete document postings from IndexedDB
     - Remove from stats
   - `clear()`:
     - Clear all IndexedDB stores for the resource
   - `searchAll()`:
     - Iterate resources, search each, merge by score
   - `dispose()`:
     - Close all IndexedDB connections
2. Add `fake-indexeddb` to devDependencies if not already present
3. Write tests in `__tests__/indexeddb.test.ts`:
   - Run shared contract tests against IndexedDbAdapter (TV-IDB-001)
   - Persistence test (TV-IDB-002)
   - Clear test (TV-IDB-003)
   - Multi-resource isolation (TV-IDB-004)
   - Lifecycle (initialize/dispose)
4. Update `src/index.ts` to export `IndexedDbAdapter` and `IndexedDbAdapterOptions`

## Verification Steps
1. `cd searchfn/adapters && npx tsc --noEmit` — no errors
2. `cd searchfn/adapters && npx vitest run` — all tests pass (including PHASE_01 tests)
3. TV-IDB-001 through TV-IDB-004 pass
4. Contract tests pass for IndexedDbAdapter (same suite as MemoryAdapter)
5. Persistence across dispose/reinitialize verified

## Stop Condition
IndexedDbAdapter fully implemented with passing tests. Both adapters pass the shared contract test suite. Report test results before proceeding to PHASE_03.
