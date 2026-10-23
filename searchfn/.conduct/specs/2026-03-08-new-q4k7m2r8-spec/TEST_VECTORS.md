# TEST VECTORS

## SearchAdapter Interface

### TV-CORE-001 — SearchAdapter type check
- **Description**: Verify that a valid adapter passes type checking.
- **Input**: Object with `name`, `index`, `search`, `remove`, `clear` methods.
- **Expected Output**: TypeScript compiles without error. Object satisfies `SearchAdapter`.

### TV-CORE-002 — SearchAdapter missing method
- **Description**: Verify that an object missing `search` does not satisfy `SearchAdapter`.
- **Input**: Object with `name`, `index`, `remove`, `clear` (no `search`).
- **Expected Output**: TypeScript compilation error. Missing property `search`.

### TV-CORE-003 — Core package exports
- **Description**: Verify all core exports are accessible.
- **Input**: `import { PipelineEngine, Indexer, DocumentStatsManager, scorePostings, QueryEngine, LruCache, IndexedDbManager } from "@searchfn/core"`
- **Expected Output**: All imports resolve. No compilation errors.

---

## Memory Adapter

### TV-MEM-001 — Basic index and search
- **Description**: Index two documents into a resource and search for a term.
- **Input**:
```json
{
  "action": "index",
  "params": {
    "resource": "tasks",
    "documents": [
      { "id": "task:1", "fields": { "title": "Buy groceries", "description": "Get milk and bread" } },
      { "id": "task:2", "fields": { "title": "Review pull request", "description": "Check auth changes" } }
    ]
  }
}
```
Then:
```json
{
  "action": "search",
  "params": { "resource": "tasks", "query": "groceries", "limit": 10 }
}
```
- **Expected Output**: `["task:1"]`

### TV-MEM-002 — Search returns empty for non-matching query
- **Description**: Search for a term that doesn't exist in any document.
- **Input**:
```json
{ "action": "search", "params": { "resource": "tasks", "query": "xyznonexistent", "limit": 10 } }
```
- **Expected Output**: `[]`

### TV-MEM-003 — Remove then search
- **Description**: Index a document, remove it, then search for it.
- **Input**:
  1. Index `{ id: "task:1", fields: { title: "Buy groceries" } }` into "tasks"
  2. Remove `{ resource: "tasks", ids: ["task:1"] }`
  3. Search `{ resource: "tasks", query: "groceries" }`
- **Expected Output**: `[]`

### TV-MEM-004 — Clear then search
- **Description**: Index documents, clear resource, then search.
- **Input**:
  1. Index 3 documents into "tasks"
  2. `clear("tasks")`
  3. Search `{ resource: "tasks", query: "groceries" }`
- **Expected Output**: `[]`

### TV-MEM-005 — Search with field restriction
- **Description**: Search only in specific fields.
- **Input**:
  1. Index `{ id: "1", fields: { title: "Alpha", description: "Beta" } }` into "items"
  2. Search `{ resource: "items", query: "Beta", fields: ["title"] }`
- **Expected Output**: `[]` (Beta is in description, not title)

### TV-MEM-006 — Search with fuzzy matching
- **Description**: Fuzzy search finds misspelled terms.
- **Input**:
  1. Index `{ id: "1", fields: { title: "groceries" } }` into "tasks"
  2. Search `{ resource: "tasks", query: "groceris", fuzzy: true }`
- **Expected Output**: `["1"]` (Levenshtein distance 1, within default threshold of 2)

### TV-MEM-007 — Search with fieldBoosts
- **Description**: Field boosts affect ranking.
- **Input**:
  1. Index `{ id: "1", fields: { title: "report", description: "quarterly data" } }` into "items"
  2. Index `{ id: "2", fields: { title: "quarterly data", description: "report" } }` into "items"
  3. Search `{ resource: "items", query: "report", fieldBoosts: { title: 3.0, description: 1.0 } }`
- **Expected Output**: `["1", "2"]` (doc 1 first because "report" is in the boosted title field)

---

## IndexedDB Adapter

### TV-IDB-001 — Basic index and search with persistence
- **Description**: Index documents, search, verify results.
- **Input**: Same as TV-MEM-001 but using IndexedDbAdapter.
- **Expected Output**: `["task:1"]`

### TV-IDB-002 — Persistence across dispose/reinitialize
- **Description**: Index documents, dispose adapter, create new adapter with same dbName, search.
- **Input**:
  1. Create `IndexedDbAdapter({ dbName: "test-persist" })`
  2. Initialize and index documents
  3. Dispose
  4. Create new `IndexedDbAdapter({ dbName: "test-persist" })`
  5. Initialize and search
- **Expected Output**: Search returns previously indexed documents.

### TV-IDB-003 — Clear removes IndexedDB data
- **Description**: Clear a resource and verify search returns empty.
- **Input**: Same as TV-MEM-004 but using IndexedDbAdapter.
- **Expected Output**: `[]`

### TV-IDB-004 — Multiple resources in same adapter
- **Description**: Index into two resources, verify isolation.
- **Input**:
  1. Index `{ id: "1", fields: { title: "Task A" } }` into "tasks"
  2. Index `{ id: "1", fields: { title: "Note A" } }` into "notes"
  3. Search `{ resource: "tasks", query: "Note" }`
- **Expected Output**: `[]`

---

## Resource Isolation

### TV-ISO-001 — Cross-resource isolation
- **Description**: Documents in resource A are not visible in resource B search.
- **Input**:
  1. Index `{ id: "1", fields: { title: "Secret task" } }` into "tasks"
  2. Search `{ resource: "notes", query: "Secret" }`
- **Expected Output**: `[]`

### TV-ISO-002 — Clear isolation
- **Description**: Clearing resource A does not affect resource B.
- **Input**:
  1. Index documents into "tasks" and "notes"
  2. `clear("tasks")`
  3. Search `{ resource: "notes", query: <term from notes> }`
- **Expected Output**: Notes results returned normally.

---

## Upsert Semantics

### TV-UPS-001 — Upsert replaces document
- **Description**: Re-indexing a document with same ID replaces it.
- **Input**:
  1. Index `{ id: "1", fields: { title: "old title" } }` into "tasks"
  2. Index `{ id: "1", fields: { title: "new title" } }` into "tasks"
  3. Search `{ resource: "tasks", query: "old" }`
- **Expected Output**: `[]`

### TV-UPS-002 — Upsert makes new content searchable
- **Description**: After upsert, new content is found.
- **Input**:
  1. Index `{ id: "1", fields: { title: "old title" } }` into "tasks"
  2. Index `{ id: "1", fields: { title: "new title" } }` into "tasks"
  3. Search `{ resource: "tasks", query: "new" }`
- **Expected Output**: `["1"]`

---

## Cross-Resource Search

### TV-XSRC-001 — searchAll across multiple resources
- **Description**: Search across tasks and notes.
- **Input**:
  1. Index `{ id: "t1", fields: { title: "Quarterly report" } }` into "tasks"
  2. Index `{ id: "n1", fields: { title: "Report summary" } }` into "notes"
  3. `searchAll({ query: "report" })`
- **Expected Output**: Array containing both `{ resource: "tasks", id: "t1", score: <number> }` and `{ resource: "notes", id: "n1", score: <number> }`, sorted by score desc.

### TV-XSRC-002 — searchAll with resource filter
- **Description**: searchAll scoped to specific resources.
- **Input**:
  1. Index documents into "tasks", "notes", "files"
  2. `searchAll({ query: "report", resources: ["tasks"] })`
- **Expected Output**: Results only from "tasks" resource.

### TV-XSRC-003 — searchAll with limitPerResource
- **Description**: Caps results per resource.
- **Input**:
  1. Index 10 matching documents into "tasks" and 10 into "notes"
  2. `searchAll({ query: <matching>, limitPerResource: 3 })`
- **Expected Output**: At most 3 results from "tasks" and 3 from "notes".

---

## SearchProvider Interface

### TV-PROV-001 — SearchProvider type check
- **Description**: Verify that the SearchProvider interface is importable and does NOT extend DatafnPlugin.
- **Input**:
```typescript
import { SearchProvider } from "@datafn/core"; // or @datafn/server
import { DatafnPlugin } from "@datafn/core";

const provider: SearchProvider = {
  name: "test",
  async search() { return []; },
  async updateIndices() {},
};

// Verify SearchProvider is NOT assignable to DatafnPlugin
// (no runsOn, no hook methods)
```
- **Expected Output**: `provider` satisfies `SearchProvider`. Provider does NOT satisfy `DatafnPlugin` (missing `runsOn` etc.).

### TV-PROV-002 — searchProvider config slot on DatafnServer
- **Description**: Verify DatafnServerConfig accepts searchProvider.
- **Input**:
```typescript
import { createDatafnServer, SearchProvider } from "@datafn/server";

const mockProvider: SearchProvider = {
  name: "memory",
  async search() { return []; },
  async updateIndices() {},
};

const server = createDatafnServer({
  schema: mySchema,
  db: myAdapter,
  searchProvider: mockProvider,
});
```
- **Expected Output**: TypeScript compiles without error. `searchProvider` accepted in config.

### TV-PROV-003 — searchProvider config slot on DatafnClient
- **Description**: Verify DatafnClientConfig accepts searchProvider.
- **Input**:
```typescript
import { createDatafnClient, SearchProvider } from "@datafn/client";

const mockProvider: SearchProvider = {
  name: "indexeddb",
  async search() { return []; },
  async updateIndices() {},
};

const client = createDatafnClient({
  schema: mySchema,
  transport: myTransport,
  searchProvider: mockProvider,
});
```
- **Expected Output**: TypeScript compiles without error. `searchProvider` accepted in config.

### TV-PROV-004 — createSearchProvider produces valid SearchProvider
- **Description**: Factory creates a provider that satisfies SearchProvider.
- **Input**:
```typescript
import { MemoryAdapter } from "@searchfn/adapters";
import { createSearchProvider } from "@searchfn/datafn-provider";

const adapter = new MemoryAdapter();
const provider = createSearchProvider(adapter);

// Type check
const isValid: SearchProvider = provider; // should compile
```
- **Expected Output**: `provider` satisfies `SearchProvider`. No compilation error.

### TV-PROV-005 — createSearchProvider delegates to adapter
- **Description**: Provider.search() delegates to adapter.search().
- **Input**:
  1. Create MemoryAdapter, index documents
  2. `createSearchProvider(adapter)`
  3. Call `provider.search({ resource: "tasks", query: "groceries" })`
- **Expected Output**: Returns same IDs as `adapter.search({ resource: "tasks", query: "groceries" })`.

---

## SearchProvider Lifecycle

### TV-INIT-001 — Provider initialization on DataFn startup
- **Description**: DataFn calls searchProvider.initialize() during startup with schema-derived config.
- **Input**:
  1. Create a mock SearchProvider with `initialize` spy
  2. Schema has `tasks` with `indices.search: ["title", "description"]` and `notes` with `indices.search: ["title"]`
  3. Create DatafnServer with `searchProvider: mockProvider`
  4. Start server
- **Expected Output**: `mockProvider.initialize` called with `{ resources: [{ name: "tasks", searchFields: ["title", "description"] }, { name: "notes", searchFields: ["title"] }] }`.

### TV-DISP-001 — Provider disposal on DataFn shutdown
- **Description**: DataFn calls searchProvider.dispose() during shutdown.
- **Input**:
  1. Create a mock SearchProvider with `dispose` spy
  2. Create and start DatafnServer with `searchProvider: mockProvider`
  3. Call server shutdown/close
- **Expected Output**: `mockProvider.dispose` called exactly once.

### TV-LIFE-001 — Adapter works without initialize
- **Description**: Adapter can index and search without calling initialize() first.
- **Input**:
  1. `const adapter = new MemoryAdapter()`
  2. `adapter.index({ resource: "x", documents: [{ id: "1", fields: { a: "hello" } }] })`
  3. `adapter.search({ resource: "x", query: "hello" })`
- **Expected Output**: `["1"]`

### TV-LIFE-002 — Dispose then method call
- **Description**: After dispose, calling search without explicit reinitialize throws canonical disposed error.
- **Input**:
  1. Create adapter, index, dispose
  2. Call `adapter.search()`
- **Expected Output**: Throws `{ code: "SEARCH_ADAPTER_DISPOSED", message: "Search adapter is disposed. Call initialize() before use." }`.

---

## DB-Native Fallback

### TV-NOPROV-001 — Server search without searchProvider
- **Description**: When no searchProvider is configured and DB adapter supports native search, server uses DB-native fallback.
- **Input**:
  1. Create DatafnServer WITHOUT searchProvider
  2. Use DB adapter fixture that supports native search capability
  3. Seed records with searchable fields
  4. Call `server.search({ query: "report" })`
- **Expected Output**: Success response with ranked results and canonical `SearchResult` shape.

### TV-NOPROV-002 — Server search without provider or DB-native support
- **Description**: When no searchProvider is configured and DB adapter lacks native search, server returns canonical unsupported error.
- **Input**:
  1. Create DatafnServer WITHOUT searchProvider
  2. Use DB adapter fixture without native search capability
  3. Call `server.search({ query: "report" })`
- **Expected Output**: `{ ok: false, error: { code: "DFQL_UNSUPPORTED", message: "No search provider configured and DB adapter has no native search support" } }`.

---

## DFQL Single-Resource Search via Provider

### TV-DFQL-001 — DFQL search block uses searchProvider
- **Description**: DFQL query with `search` block delegates to searchProvider.search().
- **Input**:
  1. Create DatafnServer with MemoryAdapter-backed searchProvider
  2. Index documents into "tasks"
  3. Execute DFQL query: `{ resource: "tasks", search: { query: "report" }, filter: { status: "active" } }`
- **Expected Output**: Provider's `search()` called with `{ resource: "tasks", query: "report" }`. Returned IDs merged with filter as `{ id: { in: candidates }, status: "active" }`. Final results are the intersection.

---

## searchAll Fallback

### TV-FALL-001 — Fallback for adapter without searchAll
- **Description**: createSearchProvider provides searchAll even when adapter doesn't have it.
- **Input**:
  1. Create adapter that implements SearchAdapter but WITHOUT searchAll
  2. `createSearchProvider(adapter, { resourceFields: { tasks: ["title"], notes: ["title"] } })`
  3. Index documents into "tasks" and "notes"
  4. Call `provider.searchAll({ query: "report" })`
- **Expected Output**: Results from both resources, sorted by synthetic score.

### TV-FALL-002 — Fallback respects limitPerResource
- **Description**: Fallback caps per-resource results.
- **Input**:
  1. Adapter without searchAll, 10 docs per resource
  2. `provider.searchAll({ query: <match>, limitPerResource: 2, limit: 10 })`
- **Expected Output**: At most 2 results per resource.

### TV-FALL-003 — Fallback without resolvable resources
- **Description**: Fallback fails deterministically when adapter lacks searchAll and no resource list is resolvable.
- **Input**:
  1. Adapter without `searchAll`
  2. `createSearchProvider(adapter, { resourceFields: {} })`
  3. `provider.searchAll({ query: "report" })` (no `resources` param)
- **Expected Output**: Rejects with `{ code: "DFQL_INVALID", message: "resources are required when adapter.searchAll is unavailable" }`.

---

## Built-in Mutation Wiring

### TV-HOOK-001 — Mutation indexes on create (built-in wiring)
- **Description**: DataFn internally calls searchProvider.updateIndices after successful create mutation.
- **Input**:
  1. Create DatafnServer with MemoryAdapter-backed searchProvider
  2. Execute create mutation: `{ resource: "tasks", data: { id: "1", title: "New task" } }`
  3. `provider.search({ resource: "tasks", query: "New task" })`
- **Expected Output**: `["1"]` — search index updated automatically after mutation.

### TV-HOOK-002 — Mutation removes on delete (built-in wiring)
- **Description**: DataFn internally calls searchProvider.updateIndices after successful delete mutation.
- **Input**:
  1. Create DatafnServer with searchProvider, index a document
  2. Execute delete mutation: `{ resource: "tasks", id: "1" }`
  3. `provider.search({ resource: "tasks", query: <prev term> })`
- **Expected Output**: `[]` — search index updated automatically after delete.

---

## Built-in Sync Wiring

### TV-SYNC-001 — Client sync indexes pulled changes (built-in wiring)
- **Description**: DataFn client internally calls searchProvider.updateIndices after sync pull.
- **Input**:
  1. Create DatafnClient with searchProvider
  2. Simulate sync pull with changes containing upserts and deletes
  3. Search for upserted content
- **Expected Output**: Upserted records found, deleted records not found. Index updated automatically.

### TV-SYNC-002 — Initial clone skip-indexing with async rebuild
- **Description**: Initial clone can defer indexing and rebuild asynchronously with progress.
- **Input**:
  1. Create DatafnClient with searchProvider and `skipCloneIndexing: true`
  2. Simulate large initial clone payload
  3. Observe rebuild progress stream
  4. Wait for rebuild completion and execute `client.search({ query: "report" })`
- **Expected Output**:
  - Clone completes without per-record indexing calls during clone write
  - Progress events emitted with increasing `percent`
  - Final event reaches `percent: 100`
  - Search returns results from cloned data after rebuild completion

---

## DataFn Cross-Resource Search

### TV-XSRV-001 — Server.search basic cross-resource
- **Description**: `DatafnServer.search()` returns merged cross-resource results.
- **Input**:
  1. Create DatafnServer with searchProvider
  2. Seed tasks + notes with matching terms
  3. Call `server.search({ query: "report", resources: ["tasks", "notes"] })`
- **Expected Output**: `result.results` contains records from both resources with scores.

### TV-XSRV-002 — Server.search with filters
- **Description**: Per-resource filters apply after candidate selection/hydration.
- **Input**:
  1. Seed tasks with mixed statuses
  2. `server.search({ query: "report", filters: { tasks: { status: "active" } } })`
- **Expected Output**: Only active tasks remain in final results.

### TV-XSRV-003 — Server.search hydration + select + deterministic ordering
- **Description**: Hydration respects `select` and stable tie-break ordering.
- **Input**:
  1. Seed equal-score candidates across two resources with deterministic ids
  2. `server.search({ query: "report", select: ["id", "title"] })`
- **Expected Output**:
  - `data` only includes `id`, `title`
  - Equal-score ordering is `resource ASC`, then `id ASC`

### TV-XCLI-001 — Client.search online proxy
- **Description**: Client search proxies to `/datafn/search` when online.
- **Input**:
  1. Create DatafnClient with mock transport online
  2. `client.search({ query: "report" })`
- **Expected Output**: Transport called once with `POST /datafn/search` and same params.

### TV-XCLI-002 — Client.search offline with provider
- **Description**: Client search executes locally when offline and provider exists.
- **Input**:
  1. Create DatafnClient offline with local searchProvider
  2. Ensure provider has indexed docs
  3. `client.search({ query: "report" })`
- **Expected Output**: Returns local results without network call.

---

## HTTP Route

### TV-HTTP-001 — Successful search response
- **Description**: POST /datafn/search returns results.
- **Input**:
```json
{
  "method": "POST",
  "path": "/datafn/search",
  "body": { "query": "report", "limit": 5 }
}
```
- **Expected Output**:
```json
{
  "ok": true,
  "result": {
    "results": [
      { "resource": "...", "id": "...", "score": 4.2, "data": { "..." } }
    ]
  }
}
```

### TV-HTTP-002 — No search provider configured
- **Description**: Successful fallback when no searchProvider is configured but DB adapter supports native search.
- **Input**: POST /datafn/search without searchProvider configured, using DB adapter fixture with native search support.
- **Expected Output**:
```json
{
  "ok": true,
  "result": {
    "results": [
      { "resource": "...", "id": "...", "score": 1.0, "data": { "..." } }
    ]
  }
}
```

### TV-HTTP-003 — Empty query rejected
- **Description**: Empty query string is rejected.
- **Input**:
```json
{
  "method": "POST",
  "path": "/datafn/search",
  "body": { "query": "" }
}
```
- **Expected Output**:
```json
{
  "ok": false,
  "error": { "code": "DFQL_INVALID", "message": "Search query must not be empty" }
}
```

### TV-HTTP-004 — No provider and no DB-native support
- **Description**: Canonical unsupported error when neither provider nor DB native search is available.
- **Input**: POST /datafn/search without searchProvider configured, using DB adapter fixture without native search support.
- **Expected Output**:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_UNSUPPORTED",
    "message": "No search provider configured and DB adapter has no native search support"
  }
}
```

---

## Backward Compatibility

### TV-BKWD-001 — InMemorySearchFn import
- **Description**: Existing import path works.
- **Input**: `import { InMemorySearchFn } from "@searchfn/client"`
- **Expected Output**: Class is available, `new InMemorySearchFn({ fields: ["title"] })` works.

### TV-BKWD-002 — SearchFn / SearchEngine import
- **Description**: Both aliases work.
- **Input**:
  1. `import { SearchFn } from "@searchfn/client"`
  2. `import { SearchEngine } from "@searchfn/client"`
- **Expected Output**: Both resolve to the same class.

### TV-BKWD-003 — All existing exports present
- **Description**: Every export from current index.ts is still exported.
- **Input**: Import all named exports from `@searchfn/client`.
- **Expected Output**: All resolve. Includes: `InMemorySearchFn`, `SearchFn`, `SearchEngine`, `PipelineEngine`, `Indexer`, `LruCache`, `QueryEngine`, `IndexedDbManager`, all type exports.

### TV-BKWD-004 — SearchFn advanced APIs preserved
- **Description**: Advanced local-first APIs on `SearchFn` remain available after restructure.
- **Input**:
  1. `import { SearchFn } from "@searchfn/client"`
  2. Instantiate and call: `addBulk`, `addBulkWithRecovery`, `flush`, `exportWorkerSnapshot`, `importWorkerSnapshot`
- **Expected Output**: Methods exist with original signatures and execute without type/runtime contract break.

### TV-BKWD-005 — Export manifest baseline check
- **Description**: Current exports are validated against a committed baseline manifest.
- **Input**: Compare generated export list from `@searchfn/client` against `exports-baseline.json`.
- **Expected Output**: No missing export names relative to baseline.

### TV-MIGR-001 — DataFn codebase migration complete
- **Description**: No references to old SearchFnPlugin or plugin scanning for search remain.
- **Input**: `grep -r "SearchFnPlugin\|plugins/searchfn\|isSearchPlugin\|hasSearchPlugin" datafn/`
- **Expected Output**: Zero matches (all migrated to searchProvider config slot).

---

## Validation & Limits

### TV-VLIM-001 — Query too long
- **Description**: Query exceeding 1000 chars is rejected.
- **Input**: POST /datafn/search with `query` of 1001 characters.
- **Expected Output**: `{ "ok": false, "error": { "code": "LIMIT_EXCEEDED", "message": "Search query exceeds maximum length" } }`

### TV-VLIM-002 — Empty query rejected
- **Description**: Same as TV-HTTP-003.

### TV-VLIM-003 — Limit clamping
- **Description**: Excessive limit is clamped.
- **Input**: POST /datafn/search with `limit: 50000`.
- **Expected Output**: Response succeeds, but at most 10,000 results returned.

### TV-VLIM-004 — Batch size limit
- **Description**: Large index batch handled.
- **Input**: `adapter.index({ resource: "x", documents: Array(15000) })`
- **Expected Output**: Succeeds via deterministic chunking (chunks <= 10,000); no size-only rejection.

### TV-VLIM-005 — resources[] cap enforced
- **Description**: Too many resources in request is rejected.
- **Input**: POST `/datafn/search` with `resources` length 51.
- **Expected Output**: `{ "ok": false, "error": { "code": "LIMIT_EXCEEDED", "message": "Too many resources in search request" } }`

### TV-VLIM-006 — Filter complexity cap enforced
- **Description**: Excessive filter depth/conditions are rejected.
- **Input**: POST `/datafn/search` with nested filter depth > 5 (or >200 conditions).
- **Expected Output**: `{ "ok": false, "error": { "code": "DFQL_INVALID", "message": "Search filters exceed allowed complexity" } }`

---

## Field Boosts

### TV-BOOST-001 — Boosts affect ranking
- **Description**: Higher boost on a field ranks matches in that field higher.
- **Input**:
  1. Index doc A: `{ title: "report", body: "data" }` and doc B: `{ title: "data", body: "report" }`
  2. Search `{ query: "report", fieldBoosts: { title: 5.0, body: 1.0 } }`
- **Expected Output**: Doc A ranked before Doc B.

---

## Fuzzy Search

### TV-FUZZ-001 — Fuzzy finds misspelling
- **Description**: Fuzzy search finds "groceries" when querying "groceris".
- **Input**:
  1. Index `{ id: "1", fields: { title: "groceries" } }`
  2. Search `{ query: "groceris", fuzzy: true }`
- **Expected Output**: `["1"]`

### TV-FUZZ-002 — Fuzzy disabled by default
- **Description**: Without fuzzy flag, misspelling not found.
- **Input**:
  1. Index `{ id: "1", fields: { title: "groceries" } }`
  2. Search `{ query: "groceris" }` (no fuzzy)
- **Expected Output**: `[]`

---

## Abort Signal

### TV-ABRT-001 — Aborted signal rejects
- **Description**: Pre-aborted signal rejects immediately.
- **Input**: `client.search({ query: "test", signal: AbortSignal.abort() })`
- **Expected Output**: Promise rejects with `{ code: "DFQL_ABORTED", message: "Search request aborted" }`.

---

## Offline Fallback

### TV-OFFL-001 — Offline without client searchProvider
- **Description**: Error when offline and no client searchProvider configured.
- **Input**: Client is offline, no searchProvider configured, call `client.search()`.
- **Expected Output**: Rejects with `{ code: "DFQL_UNSUPPORTED", message: "Search unavailable offline without search provider" }`.

---

## Per-Resource Filters

### TV-FILT-001 — Filters applied post-search
- **Description**: Per-resource filters narrow results.
- **Input**:
  1. Index tasks with various statuses
  2. `server.search({ query: "report", filters: { tasks: { status: "active" } } })`
- **Expected Output**: Only tasks with `status: "active"` appear in results.

---

## Record Hydration

### TV-HYDR-001 — Hydration with select
- **Description**: Only selected fields returned in data.
- **Input**: `server.search({ query: "report", select: ["id", "title"] })`
- **Expected Output**: Each result's `data` contains only `id` and `title` fields.

---

## End-State Search Use Cases

### TV-USEC-001 — Empty query boundary
- **Description**: `.search()` does not act as default/recents listing API.
- **Input**: `server.search({ query: "   " })`
- **Expected Output**: `{ code: "DFQL_INVALID", message: "Search query must not be empty" }`.

### TV-USEC-002 — Linking-search profile
- **Description**: Resource-scoped mixed search for linking workflows is bounded and deterministic.
- **Input**:
  1. `server.search({ query: "plan", resources: ["node", "collection"], limitPerResource: 5, limit: 10 })`
  2. Dataset has equal-score matches across both resources
- **Expected Output**:
  - Only `node` and `collection` results appear
  - At most 5 per resource and 10 overall
  - Equal-score ordering follows deterministic tie-break

### TV-USEC-003 — Strict/highlight boundary
- **Description**: Server/provider search response does not include adapter-generated highlight payloads.
- **Input**: `server.search({ query: "report" })`
- **Expected Output**: Each result contains only `resource`, `id`, `score`, `data`; no `labelSearch`, `bodySearch`, or snippet fields.

---

## Rebuild Lifecycle

### TV-REIDX-001 — Rebuild retry and completion
- **Description**: Deferred rebuild failure can be retried and eventually marks searchable state as ready.
- **Input**:
  1. Trigger deferred rebuild after clone
  2. Force first rebuild attempt failure
  3. Trigger retry
  4. Run `client.search({ query: "report" })` after retry completion
- **Expected Output**:
  - Rebuild state transitions `pending -> running -> failed -> running -> completed`
  - Retry succeeds without data loss
  - Search returns expected results after completion

---

## Determinism and Errors

### TV-DET-001 — Stable tie-break ordering
- **Description**: Equal-score results are sorted deterministically.
- **Input**: Search dataset intentionally producing equal scores across ids/resources.
- **Expected Output**: Ordered by `score DESC`, then `resource ASC`, then `id ASC` (string form), stable across repeated runs.

### TV-ERR-001 — Canonical error mapping
- **Description**: Error codes/messages are consistent across client/server/HTTP entry points.
- **Input**:
  1. Empty query
  2. Offline client without provider
  3. No provider + no DB native support
  4. Aborted request
- **Expected Output**:
  - Empty: `DFQL_INVALID` / `Search query must not be empty`
  - Offline no provider: `DFQL_UNSUPPORTED` / `Search unavailable offline without search provider`
  - No provider + no DB native: `DFQL_UNSUPPORTED` / `No search provider configured and DB adapter has no native search support`
  - Abort: `DFQL_ABORTED` / `Search request aborted`

---

## External Adapter Stubs

### TV-STUB-001 — Stub throws not implemented
- **Description**: External adapter stubs throw on method calls.
- **Input**: `new MeilisearchAdapter({ host: "..." }).search({ resource: "x", query: "y" })`
- **Expected Output**: Throws `Error("Not implemented")` or similar.
