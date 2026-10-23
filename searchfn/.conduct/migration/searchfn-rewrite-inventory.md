# SearchFn Rewrite Migration Inventory

Generated: 2026-03-08
Spec: 2026-03-08-new-97a4c153-spec

## 1. Legacy Symbols to Remove

### `@searchfn/client` — Classes & Functions

| Symbol | File | Action |
|--------|------|--------|
| `SearchFn` (class) | `searchfn/client/src/search-engine.ts` | Remove entirely |
| `SearchEngine` (alias for SearchFn) | `searchfn/client/src/index.ts` | Remove export |
| `InMemorySearchFn` (class) | `searchfn/client/src/in-memory-search.ts` | Remove entirely |
| `SearchFnOptions` / `SearchEngineOptions` | `searchfn/client/src/search-engine.ts` | Remove |
| `AddDocumentInput` / `SearchEngineAddInput` | `searchfn/client/src/search-engine.ts` | Remove |
| `SearchOptions` / `SearchEngineSearchOptions` | `searchfn/client/src/search-engine.ts` | Remove |
| `SearchResultItem` / `SearchEngineResultItem` | `searchfn/client/src/search-engine.ts` | Remove |
| `SearchFnSnapshot` | `searchfn/client/src/search-engine.ts` | Remove |
| `InMemorySearchFnOptions` | `searchfn/client/src/in-memory-search.ts` | Remove |
| `InMemorySearchFnSnapshot` | `searchfn/client/src/in-memory-search.ts` | Remove |
| `migrateFlexStoreToSearchFn` | `searchfn/client/src/compat/migration.ts` | Remove |
| `createDocumentsFromFlexStore` | `searchfn/client/src/compat/migration.ts` | Remove |
| `FlexSearchIndexAdapter` | `searchfn/client/src/compat/index-adapter.ts` | Remove |
| `FlexSearchDocumentAdapter` | `searchfn/client/src/compat/document-adapter.ts` | Remove |

### `@searchfn/client` — Internal Modules to Remove

| Module path | Reason |
|-------------|--------|
| `searchfn/client/src/search-engine.ts` | Replaced by thin `createSearchClient` |
| `searchfn/client/src/in-memory-search.ts` | Replaced by `createMemorySearchClient` |
| `searchfn/client/src/compat/` (entire dir) | Legacy migration helpers |
| `searchfn/client/src/pipeline/` (if exists) | Internal engine — moved to adapters |
| `searchfn/client/src/indexing/` (if exists) | Internal engine — moved to adapters |
| `searchfn/client/src/cache/` (if exists) | Internal engine — moved to adapters |
| `searchfn/client/src/storage/` (if exists) | Internal engine — moved to adapters |
| `searchfn/client/src/query/` (if exists) | Internal engine — moved to adapters |
| `searchfn/client/src/types.ts` (old) | Replaced by `@searchfn/adapters/types.ts` |
| `searchfn/client/src/config/` | Legacy config — moved to adapters |
| `searchfn/client/src/utils/` | Legacy utils — moved to core |

### `@searchfn/client` — Tests & Examples to Remove

| Path | Reason |
|------|--------|
| `searchfn/client/__tests__/backward-compat.test.ts` | Tests removed legacy compat |
| `searchfn/client/__tests__/migration.test.ts` | Tests removed compat function |
| `searchfn/client/__tests__/in-memory-search.test.ts` | Tests removed class |
| `searchfn/client/__tests__/search-engine.test.ts` | Tests removed class |
| `searchfn/client/__tests__/snapshot-metadata.test.ts` | Tests removed snapshot APIs |
| `searchfn/client/__tests__/fuzzy-search-integration.test.ts` | Tests removed InMemorySearchFn |
| `searchfn/client/__tests__/prefix-search-integration.test.ts` | Tests removed InMemorySearchFn |
| `searchfn/client/examples/` (all) | Uses removed classes |

### `@searchfn/server` — Legacy Exports

| Symbol | File | Action |
|--------|------|--------|
| `indexData` | `searchfn/server/src/indexing.ts` | Remove — replaced by adapter-driven server |
| `searchIndex` | `searchfn/server/src/search.ts` | Remove — replaced by adapter-driven server |
| `createSearchFnServer` (old) | `searchfn/server/src/server.ts` | Rewrite to thin adapter-based constructor |

### `@searchfn/adapters` — Type Cleanup

| Symbol | File | Action |
|--------|------|--------|
| `DocId` (re-export from core) | `searchfn/adapters/src/types.ts` | DONE — removed, inlined as `string \| number` |

## 2. New Symbols (Target Replacements)

### `@searchfn/adapters` (runtime boundary)

| Symbol | Status |
|--------|--------|
| `SearchAdapter` interface (with `capabilities`) | DONE |
| `SearchAdapterCapabilities` | DONE |
| `SearchDocument`, `IndexParams` (with `signal`), `SearchParams`, `RemoveParams` (with `signal`), `SearchAllParams`, `SearchAllResult` | DONE |
| `InitializeParams`, `InitializeResourceConfig` | DONE |
| `SearchAdapterConfig`, `SearchAdapterError`, `SEARCH_ADAPTER_DISPOSED` | DONE |
| `MemoryAdapter` (with capabilities) | DONE |
| `IndexedDbAdapter` (with capabilities) | DONE |
| `PostgresAdapter` (stub with capabilities) | DONE (stub) |
| `ElasticsearchAdapter` (stub with capabilities, `engine` option) | DONE (stub) |
| `MeilisearchAdapter` (stub with capabilities) | DONE (stub) |

### `@searchfn/client` (thin layer — to be created)

| Symbol | Target |
|--------|--------|
| `createSearchClient(config)` | New factory over any `SearchAdapter` |
| `createMemorySearchClient(config?)` | Convenience for `MemoryAdapter` |
| `createIndexedDbSearchClient(config?)` | Convenience for `IndexedDbAdapter` |
| `SearchClient` interface | New public interface |

### `@searchfn/server` (thin layer — to be rewritten)

| Symbol | Target |
|--------|--------|
| `createSearchFnServer(config)` | Accepts `SearchAdapter`, returns router |
| `SearchFnServerConfig` | With `adapter`, `basePath`, `limits`, `authorize`, `logger` |
| `SearchFnServer` | With `router` and `close()` |

### `@searchfn/datafn-provider` (bridge — to be aligned)

| Symbol | Status |
|--------|--------|
| `createSearchProvider(adapter, options?)` | Exists, needs alignment to new contract |

## 3. Internal Consumer Migration Map

### `recfn/server/src/integrations/searchfn.ts`

**Current usage**:
```ts
import { InMemorySearchFn } from '@searchfn/client';
const search = new InMemorySearchFn({ fields: FIELDS });
```

**Target replacement**:
```ts
import { createSearchClient, MemoryAdapter } from '@searchfn/client';
// or:
import { createMemorySearchClient } from '@searchfn/client';
const search = createMemorySearchClient();
```

### DataFn `clientSearch` plugin

**Current usage**: `datafn/client/src/plugins/clientSearch.ts` — uses SearchProvider from `@datafn/core`

**Target**: No change needed if `@searchfn/datafn-provider` remains the integration point.

## 4. `@searchfn/client` Re-exports of Adapter Types

**Current**: `searchfn/client/src/index.ts` re-exports all adapter types/classes from `@searchfn/adapters`.

**Target**: Thin client should import from `@searchfn/adapters` internally but expose only client-level API (`createSearchClient`, `createMemorySearchClient`, `createIndexedDbSearchClient`, `SearchClient`). Adapter re-exports may be kept for convenience but must not re-export legacy symbols.

## 5. `@searchfn/core` Dependency Notes

`@searchfn/core` exports low-level engine types (`DocId`, `PipelineEngine`, `Indexer`, etc.) used internally by `MemoryAdapter` and `IndexedDbAdapter`. These remain internal dependencies of `@searchfn/adapters` and MUST NOT leak into the public adapter contract.

The `DocId` type alias (`string | number`) has been inlined into the adapter contract. `@searchfn/adapters/src/types.ts` no longer re-exports `DocId` from core.
