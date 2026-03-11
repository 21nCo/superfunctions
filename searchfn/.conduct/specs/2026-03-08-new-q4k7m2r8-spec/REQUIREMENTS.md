# REQUIREMENTS

## Table of Contents

### Core Architecture
- [CORE-001](#core-001) SearchAdapter interface
- [CORE-002](#core-002) Memory adapter
- [CORE-003](#core-003) IndexedDB adapter
- [CORE-004](#core-004) Core package extraction
- [CORE-005](#core-005) Adapter lifecycle methods
- [CORE-006](#core-006) Multi-resource isolation
- [CORE-007](#core-007) Upsert semantics
- [CORE-008](#core-008) searchAll on adapters
- [CORE-009](#core-009) fieldBoosts support
- [CORE-010](#core-010) Fuzzy search support on adapters
- [CORE-011](#core-011) External adapter stubs

### DataFn SearchProvider Integration
- [PROV-001](#prov-001) SearchProvider interface
- [PROV-002](#prov-002) searchProvider config slot on DatafnServer
- [PROV-003](#prov-003) searchProvider config slot on DatafnClient
- [PROV-004](#prov-004) createSearchProvider factory
- [PROV-005](#prov-005) searchAll fallback in factory
- [PROV-006](#prov-006) Built-in mutation → index update wiring
- [PROV-007](#prov-007) Built-in sync → client index update wiring
- [PROV-008](#prov-008) Provider initialization on DataFn startup
- [PROV-009](#prov-009) Provider disposal on DataFn shutdown
- [PROV-010](#prov-010) DB-native search fallback (no provider)
- [PROV-011](#prov-011) DFQL single-resource search via provider
- [PROV-012](#prov-012) Local-first clone indexing lifecycle

### Cross-Resource Search
- [XSRC-001](#xsrc-001) DatafnServer.search() method
- [XSRC-002](#xsrc-002) DatafnClient.search() method
- [XSRC-003](#xsrc-003) /datafn/search HTTP route
- [XSRC-004](#xsrc-004) Per-resource filters
- [XSRC-005](#xsrc-005) Record hydration from DB
- [XSRC-006](#xsrc-006) AbortSignal support
- [XSRC-007](#xsrc-007) Offline client search fallback
- [XSRC-008](#xsrc-008) Empty-query/default-results boundary
- [XSRC-009](#xsrc-009) Linking-search profile
- [XSRC-010](#xsrc-010) Strict/highlight boundary contract

### Backward Compatibility
- [BKWD-001](#bkwd-001) InMemorySearchFn re-export
- [BKWD-002](#bkwd-002) SearchFn re-export
- [BKWD-003](#bkwd-003) Existing @searchfn/client exports
- [BKWD-004](#bkwd-004) DataFn codebase migration — remove SearchFnPlugin and plugin scanning

### Validation & Limits
- [VLIM-001](#vlim-001) Search query length validation
- [VLIM-002](#vlim-002) Search limit caps
- [VLIM-003](#vlim-003) Index batch size limits
- [VLIM-004](#vlim-004) resources[] and filter complexity caps

### Determinism & Error Contracts
- [DET-001](#det-001) Stable ordering and tie-break rules
- [DET-002](#det-002) Canonical error code mapping

---

## Requirements

---

### CORE-001

- **ID**: CORE-001
- **Priority**: P0
- **Statement**: The `SearchAdapter` interface MUST be defined in `@searchfn/adapters` with methods: `index()`, `search()`, `remove()`, `clear()`, and optional `searchAll()`, `initialize()`, `dispose()`.
- **Rationale**: Single contract for all search backends enables pluggability and the SearchProvider factory pattern.
- **Acceptance Criteria**:
  - `SearchAdapter` type is exported from `@searchfn/adapters`
  - `index()` accepts `{ resource, documents }` and returns `Promise<void>`
  - `search()` accepts `{ resource, query, fields?, limit?, fuzzy?, fieldBoosts? }` and returns `Promise<DocId[]>`
  - `remove()` accepts `{ resource, ids }` and returns `Promise<void>`
  - `clear()` accepts `resource: string` and returns `Promise<void>`
  - `searchAll()` is optional and accepts `{ query, resources?, fields?, limit?, limitPerResource?, fuzzy?, fieldBoosts? }`
  - `initialize()` and `dispose()` are optional lifecycle methods
  - The `name` property is a readonly string
- **Test Vectors**: TV-CORE-001, TV-CORE-002
- **Notes**: The interface uses `DocId = string | number` from core types.

---

### CORE-002

- **ID**: CORE-002
- **Priority**: P0
- **Statement**: The `MemoryAdapter` MUST implement `SearchAdapter` using core internals (`PipelineEngine`, `Indexer`, `DocumentStatsManager`, `scorePostings`) for pure in-memory full-text search.
- **Rationale**: Provides a zero-dependency, universal adapter for server-side (Node), client-side (browser), and testing.
- **Acceptance Criteria**:
  - `MemoryAdapter` class exported from `@searchfn/adapters`
  - `adapter.name` equals `"memory"`
  - `index()` ingests documents using `PipelineEngine` and `Indexer` from core
  - `search()` queries using `scorePostings` with BM25 and returns scored, sorted DocId[]
  - `remove()` removes documents from the in-memory postings and stats
  - `clear()` resets all state for a resource
  - `searchAll()` is implemented, searching across all initialized resources
  - Supports `fuzzy` parameter via levenshtein expansion
  - Supports `fieldBoosts` parameter
  - Maintains separate internal state per resource
- **Test Vectors**: TV-MEM-001 through TV-MEM-007
- **Notes**: Logic migrated from existing `InMemorySearchFn`.

---

### CORE-003

- **ID**: CORE-003
- **Priority**: P0
- **Statement**: The `IndexedDbAdapter` MUST implement `SearchAdapter` using core internals plus `IndexedDbManager` for persistent browser-side full-text search.
- **Rationale**: Required for offline client-side search with persistence across page reloads.
- **Acceptance Criteria**:
  - `IndexedDbAdapter` class exported from `@searchfn/adapters`
  - `adapter.name` equals `"indexeddb"`
  - Uses `IndexedDbManager` from core for persistence
  - Uses `PipelineEngine`, `Indexer`, `QueryEngine`, `LruCache` from core
  - `index()` persists documents to IndexedDB
  - `search()` retrieves postings from IndexedDB (with LRU caching), scores with BM25
  - `remove()` removes documents from IndexedDB
  - `clear()` clears all IndexedDB stores for a resource
  - `initialize()` opens the IndexedDB database
  - `dispose()` closes the IndexedDB connection
  - Each resource gets its own IndexedDB database (or namespace within one DB)
- **Test Vectors**: TV-IDB-001 through TV-IDB-004
- **Notes**: Logic migrated from existing `SearchFn` class. Requires `fake-indexeddb` for testing.

---

### CORE-004

- **ID**: CORE-004
- **Priority**: P0
- **Statement**: Core engine internals MUST be extracted into `@searchfn/core` package, exporting: `PipelineEngine`, `Indexer`, `DocumentStatsManager`, `scorePostings`, `QueryEngine`, `LruCache`, `IndexedDbManager`, `DocId`, `Token`, `PipelineOptions`, and all related types.
- **Rationale**: Adapters depend on core internals. Separating into its own package enables clean dependency management.
- **Acceptance Criteria**:
  - `@searchfn/core` package exists with its own `package.json`
  - All pipeline, indexing, query, cache, storage, and utility modules from current `searchfn/client/src/` are moved here
  - All types (`DocId`, `Token`, `PipelineOptions`, `StoredPostingChunk`, etc.) are exported
  - Existing tests pass when retargeted to the new package location
  - No circular dependencies between core modules
- **Test Vectors**: TV-CORE-003
- **Notes**: This is a code move + repackage, not a rewrite.

---

### CORE-005

- **ID**: CORE-005
- **Priority**: P1
- **Statement**: Adapters MUST support optional `initialize()` and `dispose()` lifecycle methods.
- **Rationale**: External adapters need setup (create indices) and teardown (close connections). Memory adapter can work without them.
- **Acceptance Criteria**:
  - `initialize()` called with `{ resources: [{ name, searchFields }] }` sets up per-resource state
  - Adapters MUST be functional even if `initialize()` is not called (lazy initialization on first `index()` or `search()`)
  - `dispose()` releases resources (closes DB connections, clears internal state)
  - Calling methods after `dispose()` MUST throw `SEARCH_ADAPTER_DISPOSED` unless `initialize()` is called again explicitly
- **Test Vectors**: TV-LIFE-001, TV-LIFE-002
- **Notes**: Memory adapter's `initialize()` pre-creates per-resource engines.

---

### CORE-006

- **ID**: CORE-006
- **Priority**: P0
- **Statement**: Each `resource` parameter MUST create an independent search namespace. Indexing into resource A MUST NOT affect search results for resource B.
- **Rationale**: DataFn resources are independent entities; search must respect this boundary.
- **Acceptance Criteria**:
  - Index documents into "tasks" and "notes" separately
  - Search "tasks" returns only task documents
  - Search "notes" returns only note documents
  - Clear "tasks" does not affect "notes"
  - Remove from "tasks" does not affect "notes"
- **Test Vectors**: TV-ISO-001, TV-ISO-002
- **Notes**: Applies to all adapters.

---

### CORE-007

- **ID**: CORE-007
- **Priority**: P0
- **Statement**: `adapter.index()` MUST implement upsert semantics: if a document with the same `id` already exists for the given resource, it MUST be fully replaced.
- **Rationale**: DataFn mutations update records; the search index must reflect the latest state.
- **Acceptance Criteria**:
  - Index doc `{ id: "1", fields: { title: "old" } }` then index `{ id: "1", fields: { title: "new" } }`
  - Search for "old" MUST NOT return doc "1"
  - Search for "new" MUST return doc "1"
- **Test Vectors**: TV-UPS-001, TV-UPS-002
- **Notes**: No partial update API.

---

### CORE-008

- **ID**: CORE-008
- **Priority**: P1
- **Statement**: Adapters MAY implement `searchAll()` for cross-resource search. If implemented, it MUST search across the specified resources (or all resources if omitted) and return results sorted by score descending.
- **Rationale**: Enables cross-resource search; adapters with native multi-index support (Meilisearch) can optimize this.
- **Acceptance Criteria**:
  - `searchAll({ query })` searches all indexed resources
  - `searchAll({ query, resources: ["tasks"] })` searches only "tasks"
  - Results contain `{ resource, id, score }` sorted by score desc
  - `limitPerResource` caps results per resource before merging
  - `limit` caps total results after merging
- **Test Vectors**: TV-XSRC-001 through TV-XSRC-003
- **Notes**: createSearchProvider factory provides fallback for adapters without `searchAll`.

---

### CORE-009

- **ID**: CORE-009
- **Priority**: P1
- **Statement**: Adapters that use core scoring SHOULD support `fieldBoosts` parameter to weight fields differently during search.
- **Rationale**: Title matches should rank higher than body matches (nucleus pattern).
- **Acceptance Criteria**:
  - `search({ ..., fieldBoosts: { title: 2.0, body: 1.0 } })` boosts title matches
  - Default boost for unspecified fields is 1.0
  - Boost is applied as a multiplier on the BM25 score contribution for that field
- **Test Vectors**: TV-BOOST-001
- **Notes**: External adapters may implement this using native weighting features.

---

### CORE-010

- **ID**: CORE-010
- **Priority**: P1
- **Statement**: Adapters that use core internals MUST support the `fuzzy` parameter for fuzzy matching via Levenshtein distance.
- **Rationale**: Users may misspell search terms; fuzzy matching improves recall.
- **Acceptance Criteria**:
  - `search({ ..., fuzzy: true })` enables fuzzy matching with default distance 2
  - `search({ ..., fuzzy: 1 })` enables fuzzy matching with distance 1
  - Fuzzy matches MUST have lower scores than exact matches (penalty factor)
  - `search({ ..., fuzzy: false })` or omitted disables fuzzy matching
- **Test Vectors**: TV-FUZZ-001, TV-FUZZ-002
- **Notes**: Uses existing `fuzzyExpand` from core utils.

---

### CORE-011

- **ID**: CORE-011
- **Priority**: P2
- **Statement**: External adapter files (Meilisearch, Elasticsearch, Postgres) MUST exist as stubs with the class signature and `SearchAdapter` implementation type, but MAY throw "not implemented" for all methods.
- **Rationale**: Establishes the adapter surface and enables future implementation without restructuring.
- **Acceptance Criteria**:
  - `MeilisearchAdapter`, `ElasticsearchAdapter`, `PostgresAdapter` classes exist in `@searchfn/adapters`
  - Each class `implements SearchAdapter`
  - All methods throw `Error("Not implemented")` or similar
  - Options interfaces (`MeilisearchAdapterOptions`, etc.) are defined with expected config shape
- **Test Vectors**: TV-STUB-001
- **Notes**: Implementation of these adapters is out of scope for this spec.

---

### PROV-001

- **ID**: PROV-001
- **Priority**: P0
- **Statement**: A `SearchProvider` interface MUST be defined as a dedicated, focused interface for DataFn search integration. It MUST NOT extend `DatafnPlugin`.
- **Rationale**: Search is a distinct concern, not a generic plugin. A focused interface avoids carrying plugin baggage (`runsOn`, `beforeQuery`, hook methods) that search doesn't need.
- **Acceptance Criteria**:
  - `SearchProvider` interface is defined (in `@datafn/core` or `@datafn/server`)
  - It has: `name` (readonly string), `search()`, `updateIndices()`, optional `searchAll()`, optional `initialize()`, optional `dispose()`
  - It does NOT extend `DatafnPlugin`
  - It does NOT have `runsOn`, `beforeQuery`, `afterQuery`, `beforeMutation`, `afterMutation`, `beforeSync`, `afterSync`
  - `search()` accepts `{ resource, query, type?, fields?, limit? }` and returns `Promise<string[]>`
  - `updateIndices()` accepts `{ resource, records, operation }` and returns `Promise<void>`
  - `searchAll()` accepts `{ query, resources?, fields?, limit?, limitPerResource? }` and returns `Promise<Array<{ resource, id, score }>>`
- **Test Vectors**: TV-PROV-001
- **Notes**: This replaces the old `SearchFnPlugin` / `SearchPlugin` plugin-based approach entirely.

---

### PROV-002

- **ID**: PROV-002
- **Priority**: P0
- **Statement**: `DatafnServerConfig` MUST have an optional `searchProvider?: SearchProvider` field. DataFn server MUST store it as `this.searchProvider` for deterministic O(1) access.
- **Rationale**: Dedicated config slot eliminates plugin array scanning (`plugins.find(isSearchPlugin)`). Deterministic, typed, no heuristics.
- **Acceptance Criteria**:
  - `DatafnServerConfig` type includes `searchProvider?: SearchProvider`
  - `createDatafnServer({ schema, db, searchProvider })` accepts and stores the provider
  - `this.searchProvider` is directly accessible within DataFn server internals
  - When `searchProvider` is undefined, search-related code paths use fallback behavior (PROV-010)
  - `searchProvider` is NOT added to the `plugins[]` array
- **Test Vectors**: TV-PROV-002
- **Notes**: Removes all `plugins.find(isSearchPlugin)` calls.

---

### PROV-003

- **ID**: PROV-003
- **Priority**: P0
- **Statement**: `DatafnClientConfig` MUST have an optional `searchProvider?: SearchProvider` field for offline search capability.
- **Rationale**: Client needs the same dedicated slot for offline search; symmetric with server config.
- **Acceptance Criteria**:
  - `DatafnClientConfig` type includes `searchProvider?: SearchProvider`
  - `createDatafnClient({ schema, transport, searchProvider })` accepts and stores the provider
  - `this.searchProvider` is directly accessible within DataFn client internals
  - When online, client routes to server's `/datafn/search` endpoint
  - When offline and `searchProvider` is set, client uses it locally
  - When offline and `searchProvider` is undefined, client MUST throw `DFQL_UNSUPPORTED` with message `Search unavailable offline without search provider`
- **Test Vectors**: TV-PROV-003
- **Notes**: Client-side provider is typically an IndexedDB or memory adapter.

---

### PROV-004

- **ID**: PROV-004
- **Priority**: P0
- **Statement**: `createSearchProvider(adapter, options?)` MUST be a factory in `@searchfn/datafn-provider` that converts any `SearchAdapter` into a `SearchProvider`.
- **Rationale**: Bridges the searchfn adapter world to the DataFn provider interface with a single function call.
- **Acceptance Criteria**:
  - Exported from `@searchfn/datafn-provider`
  - Accepts any `SearchAdapter` instance
  - Returns a valid `SearchProvider`
  - `provider.search()` delegates to `adapter.search()` (mapping DocId[] to string[])
  - `provider.updateIndices()` delegates to `adapter.index()` for upsert and `adapter.remove()` for delete
  - `provider.searchAll()` delegates to `adapter.searchAll()` if available
  - `provider.initialize()` delegates to `adapter.initialize()` if available
  - `provider.dispose()` delegates to `adapter.dispose()` if available
  - `options.resourceFields` provides field extraction config for mutation records
  - Factory MUST NOT modify the adapter instance
- **Test Vectors**: TV-PROV-004, TV-PROV-005
- **Notes**: Much thinner than the old plugin factory — no hooks, no runsOn, just method bridging.

---

### PROV-005

- **ID**: PROV-005
- **Priority**: P1
- **Statement**: The `createSearchProvider` factory MUST provide a `searchAll` fallback when the adapter does not implement `searchAll`.
- **Rationale**: All providers should support cross-resource search even if the underlying adapter doesn't natively.
- **Acceptance Criteria**:
  - If `adapter.searchAll` is undefined, provider `searchAll()` calls `adapter.search()` per resource in parallel
  - If `params.resources` is omitted and fallback is used, resources are derived from `options.resourceFields` keys
  - If fallback is used and neither `params.resources` nor `options.resourceFields` resources are available, provider MUST throw `DFQL_INVALID` (`resources are required when adapter.searchAll is unavailable`)
  - Position-based synthetic scores assigned: `(limitPerResource - index)` for each resource's results
  - Results are merged and sorted by deterministic order: `score DESC`, then `resource ASC`, then `id ASC` (string form)
  - `limitPerResource` caps per-resource results, `limit` caps total
  - Parallel search limited to 10 concurrent resource searches
- **Test Vectors**: TV-FALL-001, TV-FALL-002, TV-FALL-003
- **Notes**: Memory and IndexedDB adapters implement `searchAll` natively, so the fallback is primarily for external adapters that don't.

---

### PROV-006

- **ID**: PROV-006
- **Priority**: P0
- **Statement**: DataFn server MUST internally wire search index updates after successful mutations when `searchProvider` is configured. This MUST NOT be a plugin hook — it MUST be built-in logic in the mutation execution path.
- **Rationale**: Eliminates the fragile `plugins.find(isSearchPlugin)` pattern scattered across mutation code. Direct `this.searchProvider.updateIndices()` call is deterministic and simple.
- **Acceptance Criteria**:
  - After a successful create/merge/replace mutation, DataFn calls `this.searchProvider.updateIndices({ resource, records, operation: "upsert" })`
  - After a successful delete mutation, DataFn calls `this.searchProvider.updateIndices({ resource, records, operation: "delete" })`
  - The call is wrapped in try/catch — errors are logged at error level but MUST NOT fail the mutation (fail-soft)
  - When `searchProvider` is undefined, no index update logic runs (zero overhead)
  - This replaces the current `plugins.find(isSearchPlugin)` → `searchPlugin.updateIndices()` pattern in `execution/mutation/execute.ts`
- **Test Vectors**: TV-HOOK-001, TV-HOOK-002
- **Notes**: The existing test for search index updates in mutation execution should be updated to use `searchProvider` instead of plugin scanning.

---

### PROV-007

- **ID**: PROV-007
- **Priority**: P1
- **Statement**: DataFn client MUST internally wire search index updates after sync events when `searchProvider` is configured. This MUST be built-in logic, not a plugin hook.
- **Rationale**: Client-side search index must stay current with synced data. Direct wiring is simpler and more reliable than hook-based approach.
- **Acceptance Criteria**:
  - On `pull` phase: for each changed record, DataFn calls `searchProvider.updateIndices()` with upsert or delete
  - On `clone` phase: DataFn calls `searchProvider.updateIndices()` in batches for all received records unless `isInitialClone === true` and `skipCloneIndexing === true`
  - If clone indexing is skipped, DataFn schedules an asynchronous full rebuild job and marks rebuild state as `pending` then `running`
  - Rebuild progress is emitted as `{ stage, indexedRecords, totalRecords, percent }` and reaches `percent=100` on success
  - Errors are caught and logged (fail-soft)
  - Does not fire for `push` or `reconcile` phases
  - When `searchProvider` is undefined, no sync index update logic runs
- **Test Vectors**: TV-SYNC-001, TV-SYNC-002
- **Notes**: Replaces the `afterSync` hook approach.

---

### PROV-008

- **ID**: PROV-008
- **Priority**: P1
- **Statement**: During DataFn server/client startup, if `searchProvider` is configured and has an `initialize()` method, DataFn MUST call it with the schema's search field configuration.
- **Rationale**: Providers may need to set up indices, open connections, etc. DataFn has the schema info to provide resource/field config.
- **Acceptance Criteria**:
  - If `searchProvider.initialize` is a function, call it during startup
  - Pass `{ resources: [{ name, searchFields }] }` derived from `schema.resources[].indices.search`
  - Resources without `indices.search` are excluded
  - If `initialize()` throws, DataFn startup MUST fail with a descriptive error
- **Test Vectors**: TV-INIT-001
- **Notes**: Initialize is called before any mutations or queries are processed.

---

### PROV-009

- **ID**: PROV-009
- **Priority**: P2
- **Statement**: During DataFn server/client shutdown, if `searchProvider` has a `dispose()` method, DataFn MUST call it.
- **Rationale**: Providers may need to close connections, flush buffers, etc.
- **Acceptance Criteria**:
  - If `searchProvider.dispose` is a function, call it during shutdown
  - If `dispose()` throws, log the error but do not prevent shutdown
- **Test Vectors**: TV-DISP-001
- **Notes**: Best-effort cleanup.

---

### PROV-010

- **ID**: PROV-010
- **Priority**: P1
- **Statement**: When no `searchProvider` is configured, DataFn server `.search()` and DFQL search queries MUST use DB-native search when supported by the DB adapter; otherwise they MUST return `DFQL_UNSUPPORTED`.
- **Rationale**: Search should degrade gracefully, not hard-fail, when no dedicated search provider is installed.
- **Acceptance Criteria**:
  - On server without provider and with DB native support: `.search()` uses DB adapter search (LIKE/ILIKE/contains on schema search fields)
  - On server without provider and without DB native support: return `DFQL_UNSUPPORTED` with message `No search provider configured and DB adapter has no native search support`
  - On client offline without provider: return/throw `DFQL_UNSUPPORTED` with message `Search unavailable offline without search provider`
  - DB-native fallback assigns synthetic scores based on match position
  - Server fallback and unsupported paths both follow canonical `SearchResult`/error envelope
- **Test Vectors**: TV-NOPROV-001, TV-NOPROV-002
- **Notes**: DB-native fallback quality varies by DB adapter. Exact implementation per DB is out of scope — this requirement defines the fallback path, not adapter-specific SQL.

---

### PROV-011

- **ID**: PROV-011
- **Priority**: P0
- **Statement**: Existing DFQL queries with a `search` block MUST use `searchProvider.search()` when a provider is configured. This replaces the current `executeSearchQuery` → `searchPlugin.selectCandidates` pattern.
- **Rationale**: Single-resource search queries should also use the provider, not just cross-resource `.search()`.
- **Acceptance Criteria**:
  - DFQL query `{ resource: "tasks", search: { query: "report" } }` calls `searchProvider.search({ resource: "tasks", query: "report" })`
  - Returned IDs are merged with DFQL filters as `{ id: { in: candidates } }` (preserving existing two-phase execution)
  - When no provider is configured, behavior follows PROV-010 exactly (DB-native when available, `DFQL_UNSUPPORTED` otherwise)
  - Existing `executeSearchQuery()` function updated to use `searchProvider` instead of `searchPlugin`
- **Test Vectors**: TV-DFQL-001
- **Notes**: This is the single-resource counterpart to the cross-resource `.search()` method.

---

### PROV-012

- **ID**: PROV-012
- **Priority**: P1
- **Statement**: DataFn client local-first indexing lifecycle MUST support initial-clone index deferral and asynchronous rebuild with progress reporting.
- **Rationale**: Large initial datasets should avoid blocking clone completion while still guaranteeing searchable state after rebuild.
- **Acceptance Criteria**:
  - Client sync options support `skipCloneIndexing?: boolean` for initial clone flows
  - When `skipCloneIndexing === true`, clone writes records without per-record index updates
  - After clone completion, DataFn schedules asynchronous full rebuild via provider/index adapter path
  - Rebuild progress is exposed through DataFn observable/event API with `{ stage, indexedRecords, totalRecords, percent }`
  - On rebuild failure, DataFn records error state and allows retry without data loss
  - On rebuild success, search queries return results for cloned data
- **Test Vectors**: TV-SYNC-002, TV-REIDX-001
- **Notes**: Implementation MAY use worker or in-process batch runner; behavior contract is mandatory.

---

### XSRC-001

- **ID**: XSRC-001
- **Priority**: P0
- **Statement**: `DatafnServer` MUST expose a `.search()` method that performs cross-resource search.
- **Rationale**: First-class search API on the server, used by the HTTP route and directly.
- **Acceptance Criteria**:
  - Accepts `{ query, resources?, fields?, limit?, limitPerResource?, filters?, select?, namespace?, signal? }`
  - Uses `this.searchProvider` directly (no plugin scanning)
  - Calls `searchProvider.searchAll()` (or per-resource fallback) to get candidates
  - Hydrates records from the database
  - Applies per-resource filters post-search
  - Returns `SearchResult` with `results: SearchResultItem[]`
  - When no `searchProvider`: uses DB-native fallback (PROV-010)
  - Respects `signal` for cancellation
- **Test Vectors**: TV-XSRV-001, TV-XSRV-002, TV-XSRV-003
- **Notes**: Uses the same underlying DB adapter as query execution.

---

### XSRC-002

- **ID**: XSRC-002
- **Priority**: P0
- **Statement**: `DatafnClient` MUST expose a `.search()` method with the same parameter shape as the server's `.search()` (minus `namespace`).
- **Rationale**: Symmetric API for client and server.
- **Acceptance Criteria**:
  - Same parameter shape as server `.search()` (except no `namespace`)
  - When online: sends POST to `/datafn/search`
  - When offline with `searchProvider`: executes locally using `searchProvider.searchAll()`
  - When offline without `searchProvider`: throws/rejects `DFQL_UNSUPPORTED` (`Search unavailable offline without search provider`)
  - Supports `signal` for cancellation
- **Test Vectors**: TV-XCLI-001, TV-XCLI-002, TV-OFFL-001
- **Notes**: Client accesses `this.searchProvider` directly.

---

### XSRC-003

- **ID**: XSRC-003
- **Priority**: P0
- **Statement**: The DataFn server MUST expose a `POST /datafn/search` HTTP route that delegates to `server.search()`.
- **Rationale**: HTTP transport for client `.search()` calls.
- **Acceptance Criteria**:
  - Route accepts JSON body matching `server.search()` params
  - Returns DataFn envelope: `{ ok: true, result: SearchResult }` or `{ ok: false, error: DatafnError }`
  - Goes through same auth middleware as other DataFn routes
  - Returns 400 for invalid request body
  - If no `searchProvider` and DB adapter supports native search: returns successful fallback response
  - If no `searchProvider` and DB adapter lacks native search: returns `DFQL_UNSUPPORTED`
- **Test Vectors**: TV-HTTP-001, TV-HTTP-002, TV-HTTP-003, TV-NOPROV-001, TV-NOPROV-002
- **Notes**: Standard DataFn envelope format.

---

### XSRC-004

- **ID**: XSRC-004
- **Priority**: P1
- **Statement**: The `.search()` method MUST support per-resource filters that are applied AFTER search candidate selection.
- **Rationale**: Allows narrowing search results with resource-specific criteria (e.g. `status: "active"`).
- **Acceptance Criteria**:
  - `filters: { tasks: { status: "active" }, notes: { isArchived: false } }` filters results per resource
  - Filters are applied after candidates are retrieved and hydrated from DB
  - Unfiltered resources (not mentioned in `filters`) return all matching candidates
  - Filters use the same DFQL filter syntax as regular queries
- **Test Vectors**: TV-FILT-001
- **Notes**: Ensures authz filters cannot be bypassed by search scoring.

---

### XSRC-005

- **ID**: XSRC-005
- **Priority**: P0
- **Statement**: The server `.search()` method MUST hydrate full records from the database for search results, returning only requested fields via `select`.
- **Rationale**: Search providers only return IDs; full record data must come from the source of truth (DB).
- **Acceptance Criteria**:
  - After getting candidate IDs from search provider, fetch full records from DB
  - If `select` is provided, return only those fields in `data`
  - If `select` is omitted, return all fields
  - Records that no longer exist in DB (deleted between search and hydration) MUST be silently excluded
  - Final ordering is deterministic: `score DESC`, then `resource ASC`, then `id ASC` (string form)
- **Test Vectors**: TV-HYDR-001, TV-DET-001
- **Notes**: Batch fetch by IDs per resource for efficiency.

---

### XSRC-006

- **ID**: XSRC-006
- **Priority**: P1
- **Statement**: The `.search()` method on both client and server MUST support `AbortSignal` for cancellation.
- **Rationale**: Enables search-as-you-type patterns where previous requests are cancelled.
- **Acceptance Criteria**:
  - Passing an aborted signal rejects immediately with canonical code `DFQL_ABORTED`
  - Passing a signal that aborts mid-execution cancels pending work and returns `DFQL_ABORTED`
  - Client passes signal through to fetch/transport
  - Server checks signal before/during expensive operations
- **Test Vectors**: TV-ABRT-001, TV-ERR-001
- **Notes**: Aligns with nucleus's debounce + cancel pattern.

---

### XSRC-007

- **ID**: XSRC-007
- **Priority**: P1
- **Statement**: `DatafnClient.search()` MUST fall back to a local `searchProvider` when offline.
- **Rationale**: Offline-capable apps need search without network.
- **Acceptance Criteria**:
  - When transport is unavailable (offline), check `this.searchProvider`
  - If set, execute `searchProvider.searchAll()` locally
  - If not set, throw error with code `DFQL_UNSUPPORTED` and message `Search unavailable offline without search provider`
  - Online/offline detection uses the same mechanism as existing DataFn client
- **Test Vectors**: TV-OFFL-001, TV-XCLI-002
- **Notes**: Client searchProvider is configured by the app developer via `createDatafnClient({ searchProvider: createSearchProvider(new IndexedDbAdapter()) })`.

---

### XSRC-008

- **ID**: XSRC-008
- **Priority**: P1
- **Statement**: `.search()` on server and client MUST reject empty or whitespace-only queries with `DFQL_INVALID`; default/non-search results MUST be fetched via standard DataFn query APIs.
- **Rationale**: Separates search semantics from recents/default listing behavior and avoids undefined ranking for empty inputs.
- **Acceptance Criteria**:
  - `query: ""` and `query: "   "` return `DFQL_INVALID`
  - `.search()` does not return recents/default data when query is empty
  - Documentation explicitly directs callers to standard `.query()`/resource-store API for default lists
- **Test Vectors**: TV-HTTP-003, TV-USEC-001
- **Notes**: This requirement formalizes the boundary instead of implicitly relying on UI behavior.

---

### XSRC-009

- **ID**: XSRC-009
- **Priority**: P1
- **Statement**: `.search()` MUST support linking-style search flows through deterministic resource scoping and bounded result shaping.
- **Rationale**: Linking UIs require predictable mixed-resource lookups with bounded per-resource output.
- **Acceptance Criteria**:
  - `resources` parameter scopes candidate generation to the specified resources only
  - `limitPerResource` is honored before global merge and `limit`
  - For equal scores, deterministic ordering follows DET-001 tie-break rules
  - Typical linking query profile (`resources=["node","collection"]`, limited results) is covered by vectors
- **Test Vectors**: TV-USEC-002, TV-DET-001
- **Notes**: No dedicated linking endpoint is required; this is a contract on `.search()` behavior.

---

### XSRC-010

- **ID**: XSRC-010
- **Priority**: P1
- **Statement**: Search highlighting and strict-match filtering MUST remain client-side concerns; server/provider search responses MUST NOT include adapter-generated highlight payloads.
- **Rationale**: Keeps adapter/provider layer focused on candidate retrieval and ranking while preserving existing client rendering flexibility.
- **Acceptance Criteria**:
  - `SearchResultItem` contains `resource`, `id`, `score`, `data` only (no highlight snippets contract)
  - Server does not inject `labelSearch`/`bodySearch`-style highlight fields
  - Strict-match UI filtering is documented as client-side post-processing over returned data
- **Test Vectors**: TV-USEC-003
- **Notes**: Adapter-level highlighting remains out of scope in this spec revision.

---

### BKWD-001

- **ID**: BKWD-001
- **Priority**: P0
- **Statement**: `InMemorySearchFn` MUST remain importable from `@searchfn/client` after restructuring.
- **Rationale**: Existing consumers (nucleus, other projects) must not break.
- **Acceptance Criteria**:
  - `import { InMemorySearchFn } from "@searchfn/client"` works
  - `InMemorySearchFn` API is unchanged: `add()`, `search()`, `searchDetailed()`, `remove()`, `clear()`, `exportSnapshot()`, `importSnapshot()`
  - Internally may delegate to `MemoryAdapter` or be re-exported directly
- **Test Vectors**: TV-BKWD-001
- **Notes**: Can be a thin re-export or wrapper.

---

### BKWD-002

- **ID**: BKWD-002
- **Priority**: P0
- **Statement**: `SearchFn` (alias `SearchEngine`) MUST remain importable from `@searchfn/client` after restructuring.
- **Rationale**: Existing consumers must not break.
- **Acceptance Criteria**:
  - `import { SearchFn } from "@searchfn/client"` works
  - `import { SearchEngine } from "@searchfn/client"` works
  - Existing core API is preserved: `add`, `search`, `searchDetailed`, `remove`, `getDocument`, `clear`, `destroy`, `exportSnapshot`, `importSnapshot`
  - Existing advanced API is preserved: `flush`, `addBulk`, `addBulkWithRecovery`, `exportWorkerSnapshot`, `importWorkerSnapshot`
- **Test Vectors**: TV-BKWD-002, TV-BKWD-004
- **Notes**: Can delegate to `IndexedDbAdapter` internally.

---

### BKWD-003

- **ID**: BKWD-003
- **Priority**: P0
- **Statement**: All existing exports from `@searchfn/client` (types, pipeline, cache, compat, etc.) MUST remain importable.
- **Rationale**: No breaking changes to the existing package.
- **Acceptance Criteria**:
  - Every type and class currently exported from `@searchfn/client/src/index.ts` remains exported
  - Import paths `@searchfn/client` continue to resolve
  - A machine-generated export manifest (`exports-baseline.json`) is committed and compared in tests
- **Test Vectors**: TV-BKWD-003, TV-BKWD-005
- **Notes**: New exports may be added; existing ones must not be removed.

---

### BKWD-004

- **ID**: BKWD-004
- **Priority**: P0
- **Statement**: All DataFn codebase references to `SearchFnPlugin`, `isSearchPlugin`, `hasSearchPlugin`, `plugins/searchfn.ts`, and plugin-scanning code for search MUST be removed and replaced with `searchProvider` config slot access.
- **Rationale**: Complete architectural migration from plugin-based to provider-based search.
- **Acceptance Criteria**:
  - `datafn/server/src/plugins/searchfn.ts` deleted
  - No remaining imports from `plugins/searchfn` in datafn server or client
  - `SearchFnPlugin` type no longer exists anywhere in datafn
  - `isSearchPlugin()` function removed
  - `hasSearchPlugin()` in `run-hooks.ts` removed
  - All `plugins.find(isSearchPlugin)` calls replaced with `this.searchProvider` access
  - `executeSearchQuery()` updated to accept `searchProvider` parameter instead of `searchPlugin`
  - All test files updated
  - TypeScript compilation succeeds
  - All existing tests pass
- **Test Vectors**: TV-MIGR-001
- **Notes**: Search through entire `datafn/` tree. This is a more extensive migration than a simple rename — it changes the architectural pattern.

---

### VLIM-001

- **ID**: VLIM-001
- **Priority**: P1
- **Statement**: The `/datafn/search` route MUST validate that the `query` string does not exceed 1,000 characters.
- **Rationale**: Prevents abuse and excessive processing.
- **Acceptance Criteria**:
  - Query strings of 1,000 chars or fewer are accepted
  - Query strings exceeding 1,000 chars return `{ ok: false, error: { code: "LIMIT_EXCEEDED", message: "Search query exceeds maximum length" } }`
  - Empty query string returns `{ ok: false, error: { code: "DFQL_INVALID", message: "Search query must not be empty" } }`
- **Test Vectors**: TV-VLIM-001, TV-VLIM-002
- **Notes**: Configurable via server config in future.

---

### VLIM-002

- **ID**: VLIM-002
- **Priority**: P1
- **Statement**: The `/datafn/search` route MUST cap `limit` at 10,000 and `limitPerResource` at 1,000.
- **Rationale**: Prevents excessive memory usage from unbounded result sets.
- **Acceptance Criteria**:
  - `limit` defaults to 50 when omitted
  - `limit` values above 10,000 are clamped to 10,000
  - `limitPerResource` defaults to `limit` when omitted
  - `limitPerResource` values above 1,000 are clamped to 1,000
- **Test Vectors**: TV-VLIM-003
- **Notes**: Values clamped, not rejected.

---

### VLIM-003

- **ID**: VLIM-003
- **Priority**: P2
- **Statement**: `adapter.index()` MUST handle calls with more than 10,000 documents deterministically via internal batching (or explicit deterministic chunking in caller-facing helpers).
- **Rationale**: Prevents memory exhaustion during bulk indexing.
- **Acceptance Criteria**:
  - Calls with 10,000 or fewer documents succeed
  - Calls with more than 10,000 documents are processed in chunks of at most 10,000
  - Partial progress and failures are reported deterministically when recovery APIs are used
- **Test Vectors**: TV-VLIM-004, TV-REIDX-001
- **Notes**: Adapters MAY still reject unsupported payload shapes, but MUST NOT reject solely due to document count if batching path exists.

---

### VLIM-004

- **ID**: VLIM-004
- **Priority**: P1
- **Statement**: `/datafn/search` MUST enforce caps for `resources[]` size and filter complexity.
- **Rationale**: Prevents unbounded cross-resource fan-out and pathological filter payloads.
- **Acceptance Criteria**:
  - `resources.length` greater than 50 returns `LIMIT_EXCEEDED`
  - Filter object nesting depth greater than 5 returns `DFQL_INVALID`
  - Filter condition count greater than 200 returns `LIMIT_EXCEEDED`
- **Test Vectors**: TV-VLIM-005, TV-VLIM-006
- **Notes**: Limits SHOULD be configurable in server config.

---

### DET-001

- **ID**: DET-001
- **Priority**: P0
- **Statement**: All search result lists (`search`, `searchAll`, server `.search()`) MUST use deterministic ordering rules.
- **Rationale**: Stable ordering is required for reproducible UX and reliable pagination/caching behavior.
- **Acceptance Criteria**:
  - Primary sort: `score DESC`
  - Secondary sort: `resource ASC` (for cross-resource results)
  - Tertiary sort: `id ASC` using string representation
  - Equal-score ordering remains stable across repeated executions with same input/state
- **Test Vectors**: TV-DET-001
- **Notes**: Applies to native and fallback search paths.

---

### DET-002

- **ID**: DET-002
- **Priority**: P0
- **Statement**: Search APIs MUST use canonical error codes and messages across server method, client method, and HTTP route.
- **Rationale**: Uniform errors simplify client handling and observability.
- **Acceptance Criteria**:
  - Empty query -> `DFQL_INVALID` (`Search query must not be empty`)
  - Query too long / capped payload -> `LIMIT_EXCEEDED`
  - Offline client without provider -> `DFQL_UNSUPPORTED` (`Search unavailable offline without search provider`)
  - No provider + no DB native support on server -> `DFQL_UNSUPPORTED` (`No search provider configured and DB adapter has no native search support`)
  - Aborted request -> `DFQL_ABORTED`
- **Test Vectors**: TV-ERR-001, TV-HTTP-003, TV-VLIM-001, TV-OFFL-001, TV-NOPROV-002
- **Notes**: Error message text MUST be exact for the codes above.
