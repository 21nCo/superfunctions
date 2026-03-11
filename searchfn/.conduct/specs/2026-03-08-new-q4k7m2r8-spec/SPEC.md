# SearchFn Adapter Architecture + DataFn Search Integration — SPEC

## Metadata

- **Timestamp**: 2026-03-08T12:00:00Z (updated 2026-03-08T14:00:00Z, revised 2026-03-08T02:20:00Z)
- **Agent Name**: unknown-agent
- **Model**: claude-opus-4-6
- **Launcher**: VS Code
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0 / zsh
- **Git Branch**: next
- **Git Commit**: 635bf28 (dirty: 201 files changed)
- **Spec Folder**: `2026-03-08-new-q4k7m2r8-spec`
- **Spec Folder Full Path**: `searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec`
- **Spec Type**: new
- **Spec ID**: q4k7m2r8
- **Input Paths Read**:
  - `searchfn/client/src/` (full source tree)
  - `searchfn/.conduct/spec.md` (draft spec)
  - `datafn/server/src/plugins/searchfn.ts`
  - `datafn/server/src/plugins/run-hooks.ts`
  - `datafn/server/src/execution/query/search.ts`
  - `datafn/server/src/routes/query/execute.ts`
  - `datafn/server/src/execution/mutation/execute.ts`
  - `datafn/server/src/core-types.ts`
  - Conversation context: nucleus search/file architecture analysis

---

## 1. Overview

Restructure `searchfn` from a monolithic browser-first IndexedDB/BM25 library into a **core + adapters** architecture, and integrate with DataFn via a dedicated **`searchProvider` config slot** (not a generic plugin).

1. **Core** contains the engine internals (pipeline, indexer, scoring, document stats) — shared code used by all adapters.
2. **Adapters** implement a unified `SearchAdapter` interface. Memory and IndexedDB adapters use core internals directly. External adapters (Meilisearch, Elasticsearch, Postgres) implement the interface against their respective backends.
3. **SearchProvider** — a dedicated, focused interface for DataFn search integration. NOT a `DatafnPlugin`. Configured via `searchProvider` slot in DataFn constructor config. DataFn internally wires index updates after mutations and sync events. No plugin scanning, no capability detection heuristics.
4. **createSearchProvider** — a thin factory that bridges any `SearchAdapter` into a `SearchProvider`.
5. **Cross-Resource Search** — `.search()` method on both `DatafnServer` and `DatafnClient`, backed by `POST /datafn/search` route.
6. **Fallback (canonical)** — when no `searchProvider` is configured:
   - server uses DB-native search when the DB adapter supports it,
   - server returns `DFQL_UNSUPPORTED` when DB-native search is unavailable,
   - offline client returns `DFQL_UNSUPPORTED` (no local filter-scan fallback).

The existing `@searchfn/client` package (v0.2.0) is restructured but its public API (`InMemorySearchFn`, `SearchFn`, pipeline, etc.) remains available for standalone usage.

---

## 2. Glossary

| Term | Definition |
|---|---|
| **Core** | The engine internals: `PipelineEngine`, `Indexer`, `DocumentStatsManager`, `scorePostings`, `QueryEngine`, `LruCache`, `IndexedDbManager`, fuzzy/levenshtein utilities. Shared code consumed by adapters. |
| **SearchAdapter** | The universal interface that ALL search backends implement: `index()`, `search()`, `remove()`, `clear()`, and optional `searchAll()`, `initialize()`, `dispose()`. Usable standalone without DataFn. |
| **Memory Adapter** | An adapter using core's `PipelineEngine`, `Indexer`, `DocumentStatsManager`, `scorePostings` for pure in-memory full-text search. No persistence. Runs in browser or Node. |
| **IndexedDB Adapter** | An adapter using core internals plus `IndexedDbManager` for persistent browser-side full-text search. |
| **External Adapter** | An adapter delegating to an external search service (Meilisearch, Elasticsearch, Postgres). Does NOT use core internals — only implements the `SearchAdapter` interface. |
| **SearchProvider** | A dedicated DataFn interface for search. NOT a `DatafnPlugin`. Configured via `searchProvider` config slot. Has `search()`, `searchAll()`, `updateIndices()`, `initialize()`, `dispose()`. |
| **createSearchProvider** | Factory function: `SearchAdapter` → `SearchProvider`. |
| **searchProvider config slot** | A named field on DataFn server/client constructor config. Deterministic — no plugin array scanning needed. |
| **DB-native fallback** | Canonical no-provider behavior on server: use DB adapter native search when available, else return `DFQL_UNSUPPORTED`. Offline client without provider always returns `DFQL_UNSUPPORTED`. |
| **Cross-Resource Search** | Searching across multiple DataFn resource types in a single call, returning merged, score-sorted results. |
| **BM25** | Okapi BM25 scoring algorithm used by core for relevance ranking. |
| **Pipeline** | Text processing chain: tokenize → normalize → stop words → stem → edge n-grams. |
| **DocId** | `string | number` identifier for a document within a search index. |

---

## 3. Goals

1. **Unified adapter interface** — one `SearchAdapter` contract for all backends (memory, IndexedDB, Meilisearch, Elasticsearch, Postgres).
2. **Core as shared engine** — memory and IndexedDB adapters consume core internals directly; external adapters only implement the interface.
3. **Dedicated searchProvider config slot** — not a plugin in the plugins array. A typed, named field on DataFn config. Deterministic access — `this.searchProvider` instead of `plugins.find(...)`.
4. **SearchProvider is NOT a DatafnPlugin** — focused interface with only search-relevant methods. No `runsOn`, no `beforeQuery`, no hook baggage.
5. **Factory pattern** — `createSearchProvider(adapter)` converts any `SearchAdapter` to a `SearchProvider`.
6. **Canonical fallback policy** — explicit no-provider behavior is deterministic across server/client and error envelopes.
7. **Cross-resource `.search()`** — first-class method on `DatafnServer` and `DatafnClient` with `/datafn/search` route.
8. **Standalone usage preserved** — `SearchAdapter` instances are usable without DataFn.
9. **Backward compatibility** — existing `InMemorySearchFn` and `SearchFn` classes remain importable.
10. **Deterministic behavior** — stable ordering, canonical errors, and no ambiguous “throw or fallback” branches.

## 4. Non-Goals

- Semantic/vector search implementation (interface supports `type: "semantic"` but no vector adapter is in scope).
- Connectors/ingestion workers (covered by separate searchfn service spec).
- Admin dashboard/CLI for search service.
- Search result highlighting at the adapter level (client-side concern for v1).
- Multi-tenant auth for search service.

---

## 5. Public API

### 5.1 SearchAdapter Interface

```typescript
// searchfn/adapters/types.ts

type DocId = string | number;

interface SearchAdapterConfig {
  /** Fields available for indexing. MUST be set before initialize() or first index() call. */
  fields: string[];
  /** Pipeline options for adapters that use core text processing. */
  pipeline?: PipelineOptions;
}

interface SearchAdapter {
  /** Adapter name (e.g. "memory", "indexeddb", "meilisearch"). */
  readonly name: string;

  /**
   * Index documents for a given resource.
   * If a document with the same id already exists, it MUST be replaced (upsert).
   */
  index(params: {
    resource: string;
    documents: Array<{ id: DocId; fields: Record<string, string> }>;
  }): Promise<void>;

  /**
   * Remove documents from the index for a given resource.
   */
  remove(params: {
    resource: string;
    ids: DocId[];
  }): Promise<void>;

  /**
   * Search within a single resource. Returns ranked document IDs.
   */
  search(params: {
    resource: string;
    query: string;
    fields?: string[];
    limit?: number;
    fuzzy?: boolean | number;
    fieldBoosts?: Record<string, number>;
  }): Promise<DocId[]>;

  /**
   * Search across multiple resources. Returns ranked results with resource + score.
   * Adapters that do not support cross-resource search MAY omit this.
   * The createSearchProvider factory provides a fallback using per-resource search().
   */
  searchAll?(params: {
    query: string;
    resources?: string[];
    fields?: string[];
    limit?: number;
    limitPerResource?: number;
    fuzzy?: boolean | number;
    fieldBoosts?: Record<string, number>;
  }): Promise<Array<{ resource: string; id: DocId; score: number }>>;

  /** Clear all indexed data for a resource. */
  clear(resource: string): Promise<void>;

  /** Optional lifecycle: called once with resource configurations. */
  initialize?(config: {
    resources: Array<{ name: string; searchFields: string[] }>;
  }): Promise<void>;

  /** Optional lifecycle: cleanup resources. */
  dispose?(): Promise<void>;
}
```

### 5.2 Memory Adapter

```typescript
// searchfn/adapters/memory.ts

interface MemoryAdapterOptions {
  pipeline?: PipelineOptions;
}

class MemoryAdapter implements SearchAdapter {
  readonly name = "memory";
  constructor(options?: MemoryAdapterOptions);

  index(params): Promise<void>;
  remove(params): Promise<void>;
  search(params): Promise<DocId[]>;
  searchAll(params): Promise<Array<{ resource: string; id: DocId; score: number }>>;
  clear(resource: string): Promise<void>;
  initialize(config): Promise<void>;
  dispose(): Promise<void>;
}
```

Internally maintains a `Map<string, ResourceSearchEngine>` per resource using core's `PipelineEngine`, `Indexer`, `DocumentStatsManager`, and `scorePostings`. Logic migrated from `InMemorySearchFn`.

### 5.3 IndexedDB Adapter

```typescript
// searchfn/adapters/indexeddb.ts

interface IndexedDbAdapterOptions {
  dbName?: string; // default: "searchfn"
  pipeline?: PipelineOptions;
}

class IndexedDbAdapter implements SearchAdapter {
  readonly name = "indexeddb";
  constructor(options?: IndexedDbAdapterOptions);

  index(params): Promise<void>;
  remove(params): Promise<void>;
  search(params): Promise<DocId[]>;
  searchAll(params): Promise<Array<{ resource: string; id: DocId; score: number }>>;
  clear(resource: string): Promise<void>;
  initialize(config): Promise<void>;
  dispose(): Promise<void>;
}
```

Uses core's `IndexedDbManager`, `PipelineEngine`, `Indexer`, `DocumentStatsManager`, `QueryEngine`, `LruCache`. Logic migrated from `SearchFn` class.

### 5.4 External Adapter Examples (Interface Only — Implementation Deferred)

```typescript
// searchfn/adapters/meilisearch.ts — stub, implementation deferred
interface MeilisearchAdapterOptions {
  host: string;
  apiKey?: string;
  indexPrefix?: string;
}

class MeilisearchAdapter implements SearchAdapter {
  readonly name = "meilisearch";
  // All methods throw "Not implemented"
}
```

### 5.5 SearchProvider Interface (DataFn Config Slot)

```typescript
// datafn/core/src/search-provider.ts  (or datafn/server/src/search-provider.ts)

/**
 * Dedicated search provider interface for DataFn.
 * NOT a DatafnPlugin — this is a focused, typed config slot.
 * Any search library can implement this interface.
 *
 * Configured via: createDatafnServer({ searchProvider: ... })
 *                 createDatafnClient({ searchProvider: ... })
 */
export interface SearchProvider {
  /** Provider name for logging/diagnostics. */
  readonly name: string;

  /**
   * Search within a single resource. Returns ranked candidate IDs.
   * Used by DFQL queries with a `search` block.
   */
  search(params: {
    resource: string;
    query: string;
    type?: "fullText" | "semantic";
    fields?: string[];
    limit?: number;
  }): Promise<string[]>;

  /**
   * Search across multiple resources. Returns ranked results with resource + score.
   * Used by the cross-resource .search() method and /datafn/search route.
   * If not implemented, DataFn provides a fallback using per-resource search().
   */
  searchAll?(params: {
    query: string;
    resources?: string[];
    fields?: string[];
    limit?: number;
    limitPerResource?: number;
  }): Promise<Array<{ resource: string; id: string; score: number }>>;

  /**
   * Update search indices after mutations.
   * Called by DataFn internally after successful mutations.
   * Errors are caught and logged (fail-soft) — never fails the mutation.
   */
  updateIndices(params: {
    resource: string;
    records: Record<string, unknown>[];
    operation: "upsert" | "delete";
  }): Promise<void>;

  /** Optional: one-time setup (called during DataFn server/client initialization). */
  initialize?(config: {
    resources: Array<{ name: string; searchFields: string[] }>;
  }): Promise<void>;

  /** Optional: cleanup (called during DataFn server/client shutdown). */
  dispose?(): Promise<void>;
}
```

### 5.6 DataFn Constructor Config

```typescript
// Server config
interface DatafnServerConfig {
  schema: DatafnSchema;
  db: Adapter;
  plugins?: DatafnPlugin[];
  searchProvider?: SearchProvider;  // ← dedicated slot, not in plugins[]
  // ... other existing config (namespace, retention, rateLimit, etc.)
}

// Client config
interface DatafnClientConfig {
  schema: DatafnSchema;
  transport: Transport;
  plugins?: DatafnPlugin[];
  searchProvider?: SearchProvider;  // ← dedicated slot for offline search
  // ... other existing config
}
```

Usage:

```typescript
// Server with Meilisearch
const server = createDatafnServer({
  schema,
  db,
  searchProvider: createSearchProvider(new MeilisearchAdapter({ host: "..." })),
  plugins: [softDelete, audit],  // search is NOT a plugin
});

// Server with in-memory search (dev/small datasets)
const server = createDatafnServer({
  schema,
  db,
  searchProvider: createSearchProvider(new MemoryAdapter()),
});

// Client with offline IndexedDB search
const client = createDatafnClient({
  schema,
  transport,
  searchProvider: createSearchProvider(new IndexedDbAdapter({ dbName: "search" })),
});

// Server without search provider — falls back to DB-native search
const server = createDatafnServer({ schema, db });
```

### 5.7 createSearchProvider Factory

```typescript
// searchfn/datafn-provider/index.ts

import type { SearchAdapter } from "@searchfn/adapters";
import type { SearchProvider } from "@datafn/core"; // or wherever the type lives

interface CreateSearchProviderOptions {
  /** Per-resource search field config. Used to extract fields from mutation records. */
  resourceFields?: Record<string, string[]>;
}

function createSearchProvider(
  adapter: SearchAdapter,
  options?: CreateSearchProviderOptions,
): SearchProvider;
```

The factory:
- Wraps `adapter.search()` → `provider.search()` (maps DocId[] to string[])
- Wraps `adapter.index()` / `adapter.remove()` → `provider.updateIndices()`
- Wraps `adapter.searchAll()` → `provider.searchAll()` (with fallback if adapter lacks it)
- Wraps `adapter.initialize()` → `provider.initialize()`
- Wraps `adapter.dispose()` → `provider.dispose()`
- Uses `options.resourceFields` to extract search-relevant fields from mutation records
- MUST NOT modify the adapter instance

### 5.8 DataFn `.search()` Method

```typescript
// On DatafnServer
interface DatafnServer {
  search(params: {
    query: string;
    resources?: string[];
    fields?: string[];
    limit?: number;
    limitPerResource?: number;
    filters?: Record<string, Record<string, unknown>>; // per-resource filters
    select?: string[];
    namespace?: string;
    signal?: AbortSignal;
  }): Promise<SearchResult>;
}

// On DatafnClient
interface DatafnClient {
  search(params: {
    query: string;
    resources?: string[];
    fields?: string[];
    limit?: number;
    limitPerResource?: number;
    filters?: Record<string, Record<string, unknown>>;
    select?: string[];
    signal?: AbortSignal;
  }): Promise<SearchResult>;
}

interface SearchResult {
  results: SearchResultItem[];
}

interface SearchResultItem {
  resource: string;
  id: string;
  score: number;
  data?: Record<string, unknown>;
}
```

### 5.9 `/datafn/search` HTTP Route

```
POST /datafn/search

Request body:
{
  "query": "quarterly report",
  "resources": ["tasks", "notes"],        // optional, omit = all searchable
  "fields": ["title", "body"],            // optional
  "limit": 20,                            // optional, default 50
  "limitPerResource": 10,                 // optional
  "filters": {                            // optional, per-resource
    "tasks": { "status": "active" },
    "notes": { "isArchived": false }
  },
  "select": ["id", "title", "status"]     // optional
}

Response body (success):
{
  "ok": true,
  "result": {
    "results": [
      { "resource": "notes", "id": "note:abc", "score": 4.2, "data": { "title": "Q3 Report" } },
      { "resource": "tasks", "id": "task:xyz", "score": 3.8, "data": { "title": "Prepare quarterly report" } }
    ]
  }
}

Response body (error — no provider and DB adapter has no native search support):
{
  "ok": false,
  "error": {
    "code": "DFQL_UNSUPPORTED",
    "message": "No search provider configured and DB adapter has no native search support"
  }
}
```

---

## 6. Data Formats / Protocol

### 6.1 SearchAdapter.index Document Format

```json
{
  "resource": "tasks",
  "documents": [
    { "id": "task:1", "fields": { "title": "Buy groceries", "description": "Milk, bread, eggs" } },
    { "id": "task:2", "fields": { "title": "Review PR", "description": "Check the auth module changes" } }
  ]
}
```

- `id` MUST be a string or number. Adapters MUST normalize to string internally.
- `fields` MUST be a flat `Record<string, string>`. Only string values. Non-string fields MUST be stringified by the caller.

### 6.2 SearchAdapter.search Result Format

Returns `DocId[]` — an ordered array of document IDs, highest relevance first.

### 6.3 SearchAdapter.searchAll Result Format

```json
[
  { "resource": "notes", "id": "note:abc", "score": 4.2 },
  { "resource": "tasks", "id": "task:xyz", "score": 3.8 }
]
```

Sorted by `score` descending. Tie-break is `resource` ascending then `id` ascending (string form). If the adapter does not provide scores, it SHOULD use position-based scores (N, N-1, N-2, ...).

### 6.4 Canonical Search Error Codes

| Code | Message | Trigger |
|---|---|---|
| `DFQL_INVALID` | `Search query must not be empty` | Query is empty or whitespace-only |
| `LIMIT_EXCEEDED` | `Search query exceeds maximum length` | Query length > configured maximum |
| `LIMIT_EXCEEDED` | `Too many resources in search request` | `resources[]` length exceeds cap |
| `DFQL_INVALID` | `Search filters exceed allowed complexity` | Filter depth/condition cap exceeded |
| `DFQL_UNSUPPORTED` | `Search unavailable offline without search provider` | Offline client search with no provider |
| `DFQL_UNSUPPORTED` | `No search provider configured and DB adapter has no native search support` | Server no provider + no DB-native capability |
| `DFQL_ABORTED` | `Search request aborted` | AbortSignal triggered before/during execution |

---

## 7. Semantics

### 7.1 Adapter Lifecycle

1. `new Adapter(options)` — construct, no I/O.
2. `adapter.initialize(config)` — optional one-time setup (create Meilisearch indices, open IndexedDB, etc.). Adapters MUST be usable without `initialize()` if the resource is already set up.
3. `adapter.index()` / `adapter.search()` / `adapter.remove()` / `adapter.clear()` — operational methods.
4. `adapter.dispose()` — optional cleanup.

### 7.2 Upsert Semantics

`adapter.index()` MUST upsert: if a document with the same `id` already exists for the given `resource`, it MUST be fully replaced. Partial updates are NOT supported at the adapter level.

### 7.3 Multi-Resource Isolation

Each `resource` parameter creates an independent search namespace. Indexing into `"tasks"` MUST NOT affect search results for `"notes"`. Adapters MUST maintain this isolation.

### 7.4 searchAll Fallback

If a `SearchProvider`'s underlying adapter does not implement `searchAll`, the `createSearchProvider` factory MUST provide a fallback that:
1. Calls `search()` for each resource (in parallel where possible)
2. Derives resources from `params.resources` or `options.resourceFields` keys
3. If no resources are resolvable, throws `DFQL_INVALID` (`resources are required when adapter.searchAll is unavailable`)
4. Assigns synthetic scores for position-only results: `(limitPerResource - index)`
5. Merges results and applies deterministic ordering: `score DESC`, then `resource ASC`, then `id ASC` (string form)
6. Applies global `limit`

The same fallback applies on DataFn itself: if `searchProvider.searchAll` is undefined, DataFn calls `searchProvider.search()` per resource and merges.

### 7.5 DataFn `.search()` Execution Flow

**Validation gate (server + client):**
1. `query` MUST be non-empty after trim; empty query returns `DFQL_INVALID`.
2. `.search()` is not a default/recents listing API; callers MUST use regular DataFn query APIs for empty/default listing use cases.

**Server-side (with searchProvider):**
1. Access `this.searchProvider` directly from config (no scanning).
2. Call `searchProvider.searchAll()` (or fallback per-resource).
3. Group candidate IDs by resource.
4. For each resource: fetch full records from DB, apply per-resource filters, select requested fields.
5. Merge results, sort deterministically (`score DESC`, `resource ASC`, `id ASC`), apply global limit.
6. Return `SearchResult`.

**Server-side (without searchProvider — DB-native fallback):**
1. If DB adapter supports native search: for each target resource execute DB-level query (`LIKE`/`ILIKE`/`tsvector`/`contains`) on schema search-indexed fields.
2. Assign synthetic scores based on match quality or position.
3. Merge and deterministically sort (`score DESC`, `resource ASC`, `id ASC`), return `SearchResult`.
4. If DB adapter does not support native search: return `DFQL_UNSUPPORTED` with canonical message.

**Client-side:**
1. If online → POST to `/datafn/search`, return response.
2. If offline and `searchProvider` is configured → execute locally using `searchProvider.searchAll()` or per-resource fallback.
3. If offline and no `searchProvider` → return `DFQL_UNSUPPORTED` with canonical message.

### 7.6 DataFn Mutation → Index Update (Built-In Wiring)

DataFn internally wires search index updates after successful mutations. This is NOT a plugin hook — it is built-in logic in the mutation execution path:

```typescript
// In datafn mutation execution (pseudo-code)
if (this.searchProvider && mutationResult.ok) {
  try {
    const op = mutation.operation === "delete" ? "delete" : "upsert";
    await this.searchProvider.updateIndices({
      resource: mutation.resource,
      records: [record],
      operation: op,
    });
  } catch (e) {
    logger.error("Search index update failed", { error: String(e) });
    // fail-soft: never fails the mutation
  }
}
```

This replaces the current pattern of `plugins.find(isSearchPlugin)` scattered across mutation execution.

### 7.7 DataFn Sync → Client Index Update (Built-In Wiring)

On the client, DataFn internally wires search index updates after sync events:

```typescript
// In datafn client sync handling (pseudo-code)
if (this.searchProvider && syncPhase === "pull") {
  for (const change of changes) {
    try {
      if (change.operation === "delete") {
        await this.searchProvider.updateIndices({ resource: change.resource, records: [{ id: change.id }], operation: "delete" });
      } else {
        await this.searchProvider.updateIndices({ resource: change.resource, records: [change.record], operation: "upsert" });
      }
    } catch (e) {
      logger.error("Client search index update failed", { error: String(e) });
    }
  }
}
```

On `clone` phase:
1. Default behavior: bulk re-index all received records via `searchProvider.updateIndices()` in batches.
2. Initial clone optimization: when `skipCloneIndexing === true`, DataFn defers per-record clone indexing.
3. Deferred mode MUST schedule asynchronous full rebuild with progress events:
   - progress payload: `{ stage, indexedRecords, totalRecords, percent }`
   - stages: `pending`, `running`, `failed`, `completed`
4. Rebuild failure MUST be retryable without re-cloning data.
5. Search correctness requirement: once rebuild reaches `completed`, cloned records are searchable.

### 7.8 DataFn Initialization → Provider Initialization

During DataFn server/client startup, if `searchProvider` is configured and has an `initialize()` method, DataFn MUST call it with the schema's search field configuration:

```typescript
if (this.searchProvider?.initialize) {
  const resources = schema.resources
    .filter(r => r.indices?.search?.length)
    .map(r => ({ name: r.name, searchFields: r.indices.search }));
  await this.searchProvider.initialize({ resources });
}
```

During shutdown, if `searchProvider.dispose` exists, DataFn MUST call it.

### 7.9 Single-Resource DFQL Search

Existing DFQL queries with a `search` block (e.g. `{ resource: "tasks", search: { query: "report" } }`) MUST use the `searchProvider.search()` method when available. If no provider, follow canonical PROV-010 behavior (DB-native when supported, `DFQL_UNSUPPORTED` otherwise). This replaces the current `executeSearchQuery` → `searchPlugin.selectCandidates` pattern.

### 7.10 End-State Search Use-Case Contracts

1. **Empty-query boundary**: `.search()` MUST reject empty/whitespace query; default/recents listings are outside `.search()` and belong to standard query/store APIs.
2. **Linking profile support**: `.search()` MUST support bounded resource-scoped mixed-resource lookups via `resources`, `limitPerResource`, and deterministic tie-break ordering.
3. **Strict/highlight boundary**: search adapter/provider/server MUST NOT inject highlight payloads (`labelSearch`, `bodySearch`, snippets). Highlighting and strict-match UI filtering remain client-side concerns.

---

## 8. Invariants

1. **Adapter isolation**: Search results for resource A MUST NOT contain documents from resource B.
2. **Upsert idempotency**: Calling `index()` with the same document twice MUST produce identical search results as calling it once.
3. **Remove consistency**: After `remove(id)`, `search()` MUST NOT return that id.
4. **Clear completeness**: After `clear(resource)`, `search()` for that resource MUST return empty results.
5. **Score ordering**: Results from `search()` and `searchAll()` MUST be sorted by relevance score descending.
6. **Provider determinism**: `this.searchProvider` is either set or `undefined`. No scanning, no heuristics. Access is O(1).
7. **Factory purity**: `createSearchProvider(adapter)` MUST NOT modify the adapter instance.
8. **Fail-soft index updates**: Errors in `searchProvider.updateIndices()` MUST be logged but MUST NOT fail the mutation or sync operation.
9. **Stable tie-break**: Equal-score results MUST sort by `resource ASC`, then `id ASC` (string form).
10. **Canonical errors**: Search entry points (server method, client method, HTTP route) MUST use the canonical code/message mapping in §6.4.

---

## 9. Security

- The `SearchAdapter` interface has NO authentication/authorization concern. Auth is handled by DataFn's existing authz layer before the search provider is invoked.
- External adapter credentials (Meilisearch API keys, Elasticsearch auth) are passed via adapter constructor options and MUST NOT be logged.
- The `/datafn/search` route MUST go through the same auth middleware as other DataFn routes.
- Per-resource filters in `.search()` MUST be applied AFTER search candidate selection, before returning results — ensuring authz filters cannot be bypassed by search scoring.

---

## 10. Limits / Caps

| Limit | Value | Configurable? |
|---|---|---|
| Default search limit | 50 | Yes, via `limit` param |
| Max search limit | 10,000 | Yes, via server config |
| Max resources in `searchAll` | 50 | No |
| Max `limitPerResource` | 1,000 | Yes, via server config |
| Search query max length | 1,000 chars | Yes, via server config |
| Max documents per `index()` call | 10,000 | Yes, via adapter config |
| Max filter nesting depth | 5 | Yes, via server config |
| Max filter conditions | 200 | Yes, via server config |
| searchAll fallback concurrency | 10 (parallel resource searches) | No |

---

## 11. Observability

- Adapters SHOULD accept an optional logger conforming to `StorageLogger` (existing type in searchfn core).
- The DataFn search route MUST log search query execution time via the existing timing middleware.
- Index update failures MUST be logged at error level but MUST NOT throw (fail-soft).
- Adapter-specific metrics (e.g. Meilisearch queue size) are adapter-internal and MAY be exposed via adapter-specific methods.

---

## 12. Compatibility / Versioning

- **Backward compatibility**: The existing `InMemorySearchFn` and `SearchFn` classes MUST remain importable from `@searchfn/client`.
- **Package restructure**: The current `@searchfn/client` package MAY be restructured internally but its existing exports MUST NOT break.
- **Advanced API continuity**: Existing `SearchFn` methods `flush`, `addBulk`, `addBulkWithRecovery`, `exportWorkerSnapshot`, and `importWorkerSnapshot` MUST remain available.
- **Export baseline enforcement**: `@searchfn/client` exports MUST be checked against a committed baseline manifest in compatibility tests.
- **DataFn migration**: The current `SearchFnPlugin` interface, `isSearchPlugin()`, `hasSearchPlugin()`, and all plugin-scanning code for search MUST be removed and replaced with `searchProvider` config slot access. All files importing from `plugins/searchfn.ts` MUST be updated. The file `plugins/searchfn.ts` MUST be deleted.
- **New file**: `search-provider.ts` defines the `SearchProvider` interface (in core or server package).
- **Config change**: `DatafnServerConfig` and `DatafnClientConfig` gain `searchProvider?: SearchProvider` field.
- **Workspace/package rollout**: root workspace entries MUST include the new `searchfn/*` packages in release sequence before publishing updated dependents.

---

## 13. Undefined / Explicitly Not Required

- Vector/semantic search adapter implementation
- Meilisearch adapter implementation (interface only in scope; implementation deferred by user)
- Elasticsearch adapter implementation (interface only in scope; implementation deferred by user)
- Postgres adapter implementation (interface only in scope; implementation deferred by user)
- Search result highlighting at the adapter level
- Search analytics / query logging
- Search suggestions / autocomplete as a dedicated API
- Connector/ingestion workers
- Admin UI
- DB-native fallback implementation for specific DB adapters (interface defined; adapter-specific implementation is per-DB work)

---

## 14. Package Structure (Target)

```
searchfn/
├── core/                          ← Engine internals (extracted from searchfn/client/src/)
│   ├── src/
│   │   ├── pipeline/              ← PipelineEngine, stages, stemmers, stop words
│   │   ├── indexing/              ← Indexer, DocumentAccumulator
│   │   ├── query/                 ← QueryEngine, scoring, DocumentStatsManager
│   │   ├── cache/                 ← LruCache, types
│   │   ├── storage/               ← IndexedDbManager, chunk-serializer, errors
│   │   ├── utils/                 ← levenshtein, logger, env
│   │   ├── compat/               ← Existing compat adapters (FlexSearch migration)
│   │   ├── types.ts              ← DocId, StoredPostingChunk, etc.
│   │   └── index.ts              ← Re-exports all core internals
│   └── package.json              ← @searchfn/core
│
├── adapters/                      ← All adapter implementations
│   ├── src/
│   │   ├── types.ts              ← SearchAdapter interface
│   │   ├── memory.ts             ← MemoryAdapter (uses core)
│   │   ├── indexeddb.ts          ← IndexedDbAdapter (uses core)
│   │   ├── meilisearch.ts        ← MeilisearchAdapter (stub)
│   │   ├── elasticsearch.ts      ← ElasticsearchAdapter (stub)
│   │   ├── postgres.ts           ← PostgresAdapter (stub)
│   │   └── index.ts              ← Re-exports
│   └── package.json              ← @searchfn/adapters
│
├── datafn-provider/               ← DataFn SearchProvider factory
│   ├── src/
│   │   └── index.ts              ← createSearchProvider(adapter, options)
│   └── package.json              ← @searchfn/datafn-provider
│
├── client/                        ← Existing package (backward compat re-exports)
│   ├── src/
│   │   └── index.ts              ← Re-exports from @searchfn/core + @searchfn/adapters
│   └── package.json              ← @searchfn/client (existing, updated)
```

Note: `datafn-plugin/` is now `datafn-provider/` — reflecting the architectural change from plugin to provider.
