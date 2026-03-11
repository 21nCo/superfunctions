# PHASE_05 — Cross-Resource .search() + /datafn/search Route + Built-in Wiring

## Phase Goal
Add `.search()` method to DatafnServer and DatafnClient, the `POST /datafn/search` HTTP route, and built-in search index wiring for mutations and sync.

## In Scope
- `DatafnServer.search()` method implementation
- `DatafnClient.search()` method implementation
- `POST /datafn/search` HTTP route
- Request validation (query length, limit caps, empty query)
- Canonical error mapping
- Deterministic tie-break ordering
- Per-resource filters
- Record hydration from DB
- `select` field projection
- AbortSignal support
- Offline fallback on client (canonical `DFQL_UNSUPPORTED` without local scan fallback)
- Auth middleware integration
- Built-in mutation → `searchProvider.updateIndices()` wiring
- Built-in sync → `searchProvider.updateIndices()` wiring
- Initial clone indexing deferral + asynchronous rebuild progress lifecycle
- Provider initialization on startup
- Provider disposal on shutdown

## Out of Scope
- Adapter changes (done in PHASE_01-02)
- Provider factory changes (done in PHASE_04)
- Backward compat re-exports (PHASE_06)

## Deliverables
- `datafn/server/src/routes/search.ts` — HTTP route handler
- `datafn/server/src/execution/search/cross-resource.ts` — core cross-resource search logic
- Updated `datafn/server/src/server.ts` — `.search()` method, route registration, provider init/dispose, mutation wiring
- Updated `datafn/server/src/execution/mutation/execute.ts` — `this.searchProvider.updateIndices()` call after mutations (fail-soft)
- Updated `datafn/client/src/client.ts` — `.search()` method, offline fallback, sync wiring
- Updated `datafn/client/src/search-rebuild.ts` (or equivalent) — deferred rebuild runner + progress events
- Updated `datafn/server/src/index.ts` — export `SearchResult`, `SearchResultItem` types
- `datafn/server/src/routes/__tests__/search.test.ts` — route tests
- `datafn/server/src/execution/search/__tests__/cross-resource.test.ts` — logic tests
- `datafn/client/__tests__/search.test.ts` — client search tests
- `datafn/server/src/execution/mutation/__tests__/search-wiring.test.ts` — mutation → index wiring tests

## Requirements Covered
- XSRC-001, XSRC-002, XSRC-003, XSRC-004, XSRC-005, XSRC-006, XSRC-007, XSRC-008, XSRC-009, XSRC-010
- PROV-006, PROV-007, PROV-008, PROV-009, PROV-010, PROV-011, PROV-012
- VLIM-001, VLIM-002, VLIM-004
- DET-001, DET-002

## Implementation Tasks

### Server-Side

1. Create `datafn/server/src/execution/search/cross-resource.ts`:
   ```typescript
   export async function executeCrossResourceSearch(
     params: CrossResourceSearchParams,
     searchProvider: SearchProvider,
     db: Adapter,
     schema: DatafnSchema,
     namespace: string,
     logger?: DatafnLogger,
   ): Promise<SearchResult> { ... }
   ```
   - Call `searchProvider.searchAll()` to get candidates
   - Group candidates by resource
   - For each resource: batch fetch records from DB via `db.getByIds()` or equivalent
   - Apply per-resource filters (reuse DFQL filter evaluation)
   - Apply `select` field projection
   - Silently exclude records not found in DB (deleted between search and hydration)
   - Merge results, preserve search score ordering
   - Apply global `limit`
   - Return `SearchResult`

2. Create `datafn/server/src/routes/search.ts`:
   - Parse and validate request body:
     - `query`: required, string, max 1000 chars, non-empty
     - `resources`: optional string[]
     - `fields`: optional string[]
     - `limit`: optional number, default 50, clamped to 10,000
     - `limitPerResource`: optional number, default = limit, clamped to 1,000
     - `filters`: optional Record<string, Record<string, unknown>>
     - `select`: optional string[]
   - Validate complexity caps (`resources.length <= 50`, filter depth/condition count limits)
   - Check `this.searchProvider`
   - If no provider and DB adapter supports native search: execute DB-native fallback
   - If no provider and no DB-native search: return `{ ok: false, error: { code: "DFQL_UNSUPPORTED", message: "No search provider configured and DB adapter has no native search support" } }`
   - Call `executeCrossResourceSearch()`
   - Return DataFn envelope: `{ ok: true, result: searchResult }`
   - Error handling: catch and return appropriate DataFn error envelope

3. Add `.search()` method to `DatafnServer` in `server.ts`:
   - Same params as the route handler (minus HTTP concerns)
   - Delegates to `executeCrossResourceSearch()`
   - Uses `this.searchProvider` directly (no plugin scanning)
   - When no `searchProvider`: follows canonical PROV-010 behavior
   - Enforce deterministic ordering (`score DESC`, `resource ASC`, `id ASC`)

4. Register `POST /datafn/search` route in server setup:
   - Goes through same auth middleware as query/mutation routes
   - Placed alongside other route registrations

5. Wire provider initialization in server startup:
   - If `this.searchProvider?.initialize`, call with `{ resources }` derived from schema
   - If initialize throws, fail startup with descriptive error

6. Wire provider disposal in server shutdown:
   - If `this.searchProvider?.dispose`, call during shutdown
   - If dispose throws, log error but don't prevent shutdown

7. Wire mutation → index update in `execution/mutation/execute.ts`:
   - After successful create/merge/replace: call `this.searchProvider.updateIndices({ resource, records, operation: "upsert" })` wrapped in try/catch (fail-soft, log errors)
   - After successful delete: call `this.searchProvider.updateIndices({ resource, records, operation: "delete" })` wrapped in try/catch
   - Guard with `if (this.searchProvider)` — zero overhead when not configured

8. Update DFQL single-resource search execution:
   - `executeSearchQuery()` uses `searchProvider.search()` instead of the old `searchPlugin.selectCandidates()`
   - (Already partly done in PHASE_03, finish wiring here)

### Client-Side

9. Add `.search()` method to `DatafnClient` in `client.ts`:
   ```typescript
   async search(params: ClientSearchParams): Promise<SearchResult> {
     if (this.isOnline()) {
       return this.transport.post("/datafn/search", params, { signal: params.signal });
     }
     // Offline fallback
     if (!this.searchProvider?.searchAll) {
       throw new DatafnClientError("DFQL_UNSUPPORTED", "Search unavailable offline without search provider");
     }
     const candidates = await this.searchProvider.searchAll({
       query: params.query,
       resources: params.resources,
       fields: params.fields,
       limit: params.limit,
       limitPerResource: params.limitPerResource,
     });
    // Hydrate from local store if available; enforce deterministic tie-break
    return { results: sortDeterministically(candidates).map(c => ({ ...c, data: undefined })) };
   }
   ```

10. Wire sync → index update in client sync handling:
    - On `pull` phase: call `this.searchProvider.updateIndices()` for changed records
    - On `clone` phase with normal mode: bulk re-index all received records
    - On initial clone with `skipCloneIndexing`: defer clone indexing and run asynchronous full rebuild
    - Emit rebuild progress `{ stage, indexedRecords, totalRecords, percent }`
    - Support rebuild retry path on failure
    - Wrapped in try/catch (fail-soft)
    - Guard with `if (this.searchProvider)` — zero overhead when not configured

11. Wire provider initialization in client startup (if applicable)
12. Wire provider disposal in client shutdown (if applicable)

13. Export types from `datafn/server/src/index.ts`:
    - `SearchResult`, `SearchResultItem`

### Tests

14. Write `routes/__tests__/search.test.ts`:
    - TV-HTTP-001: successful search response
    - TV-HTTP-002: no searchProvider + DB-native support → success fallback
    - TV-HTTP-003: empty query → 400
    - TV-HTTP-004: no provider + no DB-native support → unsupported error
    - TV-VLIM-001: query too long → error
    - TV-VLIM-003: limit clamping
    - TV-VLIM-005 / TV-VLIM-006: resources/filter complexity caps

15. Write `execution/search/__tests__/cross-resource.test.ts`:
    - TV-XSRV-001: basic cross-resource search
    - TV-XSRV-002: search with per-resource filters (TV-FILT-001)
    - TV-XSRV-003: hydration with select (TV-HYDR-001)
    - TV-DET-001: deterministic tie-break ordering
    - Deleted records silently excluded

16. Write `client/__tests__/search.test.ts`:
    - TV-XCLI-001: online proxies to server
    - TV-XCLI-002: offline with searchProvider works
    - TV-OFFL-001: offline without searchProvider throws
    - TV-USEC-001: empty query boundary
    - TV-USEC-002: linking-search profile
    - TV-USEC-003: strict/highlight boundary (no highlight payloads)
    - TV-ABRT-001: abort signal

17. Write `execution/mutation/__tests__/search-wiring.test.ts`:
    - TV-HOOK-001: mutation → index on create (built-in wiring)
    - TV-HOOK-002: mutation → remove on delete (built-in wiring)
    - Verify fail-soft: provider error does not fail the mutation
    - TV-SYNC-001: sync → index on pull (client)
    - TV-SYNC-002: initial clone skip-indexing + async rebuild progress
    - TV-REIDX-001: rebuild retry and completion
    - TV-INIT-001: provider initialization on startup
    - TV-DISP-001: provider disposal on shutdown
    - TV-NOPROV-001 / TV-NOPROV-002: canonical no-provider behaviors
    - TV-DFQL-001: DFQL search block uses searchProvider
    - TV-ERR-001: canonical error mapping across entry points

## Verification Steps
1. `cd datafn/server && npx tsc --noEmit` — no errors
2. `cd datafn/server && npx vitest run` — all tests pass (including existing tests)
3. `cd datafn/client && npx tsc --noEmit` — no errors
4. `cd datafn/client && npx vitest run` — all tests pass
5. Route tests pass: TV-HTTP-001, TV-HTTP-002, TV-HTTP-003, TV-HTTP-004
6. Validation tests pass: TV-VLIM-001, TV-VLIM-003, TV-VLIM-005, TV-VLIM-006
7. Cross-resource tests pass: TV-XSRV-001, TV-XSRV-002, TV-XSRV-003
8. Client tests pass: TV-XCLI-001, TV-XCLI-002, TV-OFFL-001, TV-ABRT-001, TV-USEC-001, TV-USEC-002, TV-USEC-003
9. Wiring tests pass: TV-HOOK-001, TV-HOOK-002, TV-SYNC-001, TV-SYNC-002, TV-REIDX-001, TV-INIT-001, TV-DISP-001
10. DFQL test passes: TV-DFQL-001
11. Fallback tests pass: TV-NOPROV-001, TV-NOPROV-002
12. Error contract tests pass: TV-ERR-001 and deterministic ordering TV-DET-001

## Stop Condition
`.search()` works on server and client, HTTP route functional, validation enforced, built-in mutation/sync wiring works, provider lifecycle managed. All tests pass. Report test results before proceeding to PHASE_06.
