# PHASE_03 — SearchProvider Interface + DataFn Config Slot + Codebase Migration

## Phase Goal
Define the `SearchProvider` interface (NOT extending DatafnPlugin), add `searchProvider` config slot to DatafnServerConfig and DatafnClientConfig, and remove all plugin-based search scanning from the DataFn codebase.

## In Scope
- Define `SearchProvider` interface in `@datafn/core` (or `@datafn/server`)
- Add `searchProvider?: SearchProvider` to `DatafnServerConfig` and `DatafnClientConfig`
- Store as `this.searchProvider` on server and client instances
- Delete `datafn/server/src/plugins/searchfn.ts`
- Remove `isSearchPlugin()` function
- Remove `hasSearchPlugin()` from `run-hooks.ts`
- Remove all `plugins.find(isSearchPlugin)` calls, replace with `this.searchProvider` access
- Update `executeSearchQuery()` to accept `searchProvider` parameter instead of `searchPlugin`
- Update all test files

## Out of Scope
- Creating the `@searchfn/datafn-provider` package (PHASE_04)
- Cross-resource search route or `.search()` method (PHASE_05)
- Built-in mutation/sync wiring (PHASE_05)
- Any searchfn package changes

## Deliverables
- `datafn/core/src/search-provider.ts` (or `datafn/server/src/search-provider.ts`) — `SearchProvider` interface definition
- Updated `datafn/server/src/core-types.ts` — `DatafnServerConfig` with `searchProvider?: SearchProvider`
- Updated `datafn/client/src/client.ts` — `DatafnClientConfig` with `searchProvider?: SearchProvider`, stored as `this.searchProvider`
- Updated `datafn/server/src/server.ts` — store `searchProvider` from config as `this.searchProvider`
- Updated `datafn/server/src/execution/query/search.ts` — use `searchProvider` param instead of `searchPlugin`
- Updated `datafn/server/src/execution/mutation/execute.ts` — remove `plugins.find(isSearchPlugin)` pattern (wiring moved to PHASE_05)
- Updated `datafn/server/src/routes/query/execute.ts` — use `this.searchProvider` instead of plugin scanning
- Updated `datafn/server/src/plugins/run-hooks.ts` — remove `hasSearchPlugin()`
- Updated `datafn/server/src/index.ts` — export `SearchProvider`, remove `SearchFnPlugin` / `isSearchPlugin`
- Updated test files referencing `SearchFnPlugin`, `isSearchPlugin`, `searchPlugin`
- Deleted `datafn/server/src/plugins/searchfn.ts`

## Requirements Covered
- PROV-001, PROV-002, PROV-003, BKWD-004

## Implementation Tasks
1. Create `SearchProvider` interface:
   ```typescript
   export interface SearchProvider {
     readonly name: string;
     search(params: {
       resource: string;
       query: string;
       type?: "fullText" | "semantic";
       fields?: string[];
       limit?: number;
     }): Promise<string[]>;
     searchAll?(params: {
       query: string;
       resources?: string[];
       fields?: string[];
       limit?: number;
       limitPerResource?: number;
     }): Promise<Array<{ resource: string; id: string; score: number }>>;
     updateIndices(params: {
       resource: string;
       records: Record<string, unknown>[];
       operation: "upsert" | "delete";
     }): Promise<void>;
     initialize?(config: {
       resources: Array<{ name: string; searchFields: string[] }>;
     }): Promise<void>;
     dispose?(): Promise<void>;
   }
   ```
2. Add `searchProvider?: SearchProvider` to `DatafnServerConfig` in `core-types.ts`
3. Add `searchProvider?: SearchProvider` to `DatafnClientConfig` in `client.ts`
4. Update server constructor to store `this.searchProvider = config.searchProvider`
5. Update client constructor to store `this.searchProvider = config.searchProvider`
6. Update `datafn/server/src/execution/query/search.ts`:
   - Change function signature to accept `searchProvider: SearchProvider` instead of `searchPlugin: SearchPlugin`
   - Change `searchPlugin.selectCandidates()` to `searchProvider.search()`
   - Map the parameter shape accordingly
7. Update `datafn/server/src/routes/query/execute.ts`:
   - Remove `plugins.find(isSearchPlugin)` call
   - Pass `this.searchProvider` to `executeSearchQuery()` instead
   - If no `searchProvider`, handle fallback (PROV-010)
8. Update `datafn/server/src/execution/mutation/execute.ts`:
   - Remove `plugins.find(isSearchPlugin)` → `searchPlugin.updateIndices()` calls (lines ~911-918, 980-996)
   - Leave comment: `// Search index updates wired in PHASE_05 via this.searchProvider`
9. Remove `hasSearchPlugin()` from `datafn/server/src/plugins/run-hooks.ts`
10. Delete `datafn/server/src/plugins/searchfn.ts`
11. Update `datafn/server/src/index.ts`:
    - Export `SearchProvider` type
    - Remove `SearchFnPlugin`, `isSearchPlugin` exports
12. Grep entire `datafn/` tree for remaining references to `SearchFnPlugin`, `isSearchPlugin`, `hasSearchPlugin`, `plugins/searchfn` and fix any found
13. Update all test files:
    - Replace mock `SearchFnPlugin` objects with mock `SearchProvider` objects
    - Remove `name: "searchfn"` from mocks (provider has `name` but it's not used for detection)
    - Update test assertions to match new `searchProvider` parameter passing
14. Run TypeScript compilation
15. Run all datafn server and client tests

## Verification Steps
1. `cd datafn/server && npx tsc --noEmit` — no errors
2. `cd datafn/client && npx tsc --noEmit` — no errors
3. `cd datafn/server && npx vitest run` — all tests pass
4. `cd datafn/client && npx vitest run` — all tests pass
5. `grep -r "SearchFnPlugin" datafn/` — zero matches
6. `grep -r "isSearchPlugin" datafn/` — zero matches
7. `grep -r "hasSearchPlugin" datafn/` — zero matches
8. `grep -r "plugins/searchfn" datafn/` — zero matches
9. `grep -r "plugins\.find.*[Ss]earch" datafn/` — zero matches (no plugin scanning for search)
10. TV-PROV-001 verified by compilation (SearchProvider exists and does NOT extend DatafnPlugin)
11. TV-PROV-002 verified by compilation (searchProvider accepted in DatafnServerConfig)
12. TV-PROV-003 verified by compilation (searchProvider accepted in DatafnClientConfig)
13. TV-MIGR-001 verified by grep

## Stop Condition
SearchProvider interface defined, config slots added, all old plugin-based search code removed, all tests pass, grep confirms no old references. Report test results and any issues found before proceeding to PHASE_04.
