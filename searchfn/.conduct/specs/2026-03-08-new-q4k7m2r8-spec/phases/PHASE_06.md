# PHASE_06 — External Adapter Stubs + @searchfn/client Backward Compatibility

## Phase Goal
Add external adapter stubs (Meilisearch, Elasticsearch, Postgres) and ensure `@searchfn/client` backward compatibility by re-exporting from core and adapters.

## In Scope
- Meilisearch, Elasticsearch, Postgres adapter stubs (interfaces + throw "not implemented")
- Update `@searchfn/client` to re-export from `@searchfn/core` and `@searchfn/adapters`
- Preserve all existing `@searchfn/client` exports
- Preserve `InMemorySearchFn` and `SearchFn`/`SearchEngine` classes
- Tests verifying import compatibility

## Out of Scope
- Implementing external adapter logic
- Modifying adapter or core internals

## Deliverables
- `searchfn/adapters/src/meilisearch.ts` — stub class
- `searchfn/adapters/src/elasticsearch.ts` — stub class
- `searchfn/adapters/src/postgres.ts` — stub class
- Updated `searchfn/adapters/src/index.ts` — export stubs
- Updated `searchfn/client/src/index.ts` — re-export from core + provide InMemorySearchFn/SearchFn wrappers
- `searchfn/client/__tests__/backward-compat.test.ts` — import verification tests
- `searchfn/adapters/__tests__/stubs.test.ts` — stub tests

## Requirements Covered
- CORE-011, BKWD-001, BKWD-002, BKWD-003

## Implementation Tasks

### External Adapter Stubs

1. Create `searchfn/adapters/src/meilisearch.ts`:
   ```typescript
   export interface MeilisearchAdapterOptions {
     host: string;
     apiKey?: string;
     indexPrefix?: string;
   }
   export class MeilisearchAdapter implements SearchAdapter {
     readonly name = "meilisearch";
     constructor(public readonly options: MeilisearchAdapterOptions) {}
     async index(): Promise<void> { throw new Error("MeilisearchAdapter: not implemented"); }
     async search(): Promise<DocId[]> { throw new Error("MeilisearchAdapter: not implemented"); }
     async remove(): Promise<void> { throw new Error("MeilisearchAdapter: not implemented"); }
     async clear(): Promise<void> { throw new Error("MeilisearchAdapter: not implemented"); }
     async initialize(): Promise<void> { throw new Error("MeilisearchAdapter: not implemented"); }
     async dispose(): Promise<void> { throw new Error("MeilisearchAdapter: not implemented"); }
   }
   ```

2. Create `searchfn/adapters/src/elasticsearch.ts` — same pattern, `ElasticsearchAdapterOptions` with `node`, `auth?`

3. Create `searchfn/adapters/src/postgres.ts` — same pattern, `PostgresAdapterOptions` with `connectionString`, `schema?`

4. Update `searchfn/adapters/src/index.ts` to export all stubs

5. Write `searchfn/adapters/__tests__/stubs.test.ts`:
   - TV-STUB-001: each stub throws "not implemented" on method calls
   - Verify all stubs implement `SearchAdapter` type

### Backward Compatibility

6. Update `searchfn/client/package.json`:
   - Add `@searchfn/core` and `@searchfn/adapters` as dependencies

7. Update `searchfn/client/src/index.ts` to re-export from core and provide compat wrappers:
   ```typescript
   // Re-export all core internals
   export * from "@searchfn/core";

   // Re-export adapters
   export { MemoryAdapter, IndexedDbAdapter, SearchAdapter } from "@searchfn/adapters";

   // Backward compatibility: InMemorySearchFn wraps MemoryAdapter
   // OR re-export existing class if kept alongside adapter
   export { InMemorySearchFn } from "./in-memory-search"; // keep existing file
   // OR
   export { InMemorySearchFn } from "@searchfn/core"; // if moved to core

   // Backward compatibility: SearchFn / SearchEngine
   export { SearchFn, SearchFn as SearchEngine } from "./search-engine"; // keep existing
   // OR wrap IndexedDbAdapter

   // Existing type re-exports for backward compat
   export type {
     SearchFnOptions as SearchEngineOptions,
     AddDocumentInput as SearchEngineAddInput,
     SearchOptions as SearchEngineSearchOptions,
     SearchResultItem as SearchEngineResultItem
   } from "./search-engine";
   ```

   Decision: Keep `InMemorySearchFn` and `SearchFn` classes in `@searchfn/client` as-is for backward compat. They are NOT moved to adapters — they coexist. The adapters are the new recommended API; the old classes are preserved imports.

8. Write `searchfn/client/__tests__/backward-compat.test.ts`:
   - TV-BKWD-001: `import { InMemorySearchFn } from "@searchfn/client"` — class available, basic usage works
   - TV-BKWD-002: `import { SearchFn, SearchEngine } from "@searchfn/client"` — both resolve to same class
   - TV-BKWD-003: all existing exports still importable (check against snapshot of current exports)
   - TV-BKWD-004: advanced `SearchFn` APIs (`flush`, `addBulk`, `addBulkWithRecovery`, `exportWorkerSnapshot`, `importWorkerSnapshot`) preserved
   - TV-BKWD-005: export manifest baseline check against committed `exports-baseline.json`

9. Verify `@searchfn/client` existing tests still pass

## Verification Steps
1. `cd searchfn/adapters && npx tsc --noEmit` — no errors
2. `cd searchfn/adapters && npx vitest run` — all tests pass
3. `cd searchfn/client && npx tsc --noEmit` — no errors
4. `cd searchfn/client && npx vitest run` — all tests pass (including existing tests)
5. TV-STUB-001 passes
6. TV-BKWD-001, TV-BKWD-002, TV-BKWD-003, TV-BKWD-004, TV-BKWD-005 pass
7. All packages in the searchfn workspace compile and test successfully

## Stop Condition
All stubs created, backward compatibility verified, all existing tests pass. Report full test suite results across all searchfn packages. This is the final phase.
