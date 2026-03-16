# Phase 00 Export Mapping

Spec: `2026-03-11-new-h3r9k2m7-spec`
Phase: `PHASE_00`
Source of truth export surface: `searchfn/adapters/src/index.ts`

## Canonical Legacy Export Inventory

The following items are exported by legacy `@searchfn/adapters`:

1. Types from `./types`
- `SearchDocument`
- `IndexParams`
- `SearchParams`
- `RemoveParams`
- `SearchAllParams`
- `SearchAllResult`
- `InitializeParams`
- `InitializeResourceConfig`
- `SearchAdapter`
- `SearchAdapterCapabilities`
- `SearchAdapterConfig`

2. Error/constants from `./types`
- `SEARCH_ADAPTER_DISPOSED`
- `SearchAdapterError`

3. Concrete adapters
- `MemoryAdapter` from `./memory`
- `IndexedDbAdapter` and `IndexedDbAdapterOptions` from `./indexeddb`
- `MeilisearchAdapter` and `MeilisearchAdapterOptions` from `./meilisearch`
- `ElasticsearchAdapter` and `ElasticsearchAdapterOptions` from `./elasticsearch`
- `OpenSearchAdapter` and `OpenSearchAdapterOptions` from `./opensearch`
- `PostgresAdapter` and `PostgresAdapterOptions` from `./postgres`

4. Utility alias
- `redactSearchFnLogContext` (alias of `redactSensitive`) from `./internal/redaction`

## Target Package Mapping (Locked)

Per SPEC requirements, mapping is:

- `@searchfn/adapter-contracts`
  - `SearchDocument`
  - `IndexParams`
  - `SearchParams`
  - `RemoveParams`
  - `SearchAllParams`
  - `SearchAllResult`
  - `InitializeParams`
  - `InitializeResourceConfig`
  - `SearchAdapter`
  - `SearchAdapterCapabilities`
  - `SearchAdapterConfig`
  - `SEARCH_ADAPTER_DISPOSED`
  - `SearchAdapterError`

- `@searchfn/adapter-memory`
  - `MemoryAdapter`

- `@searchfn/adapter-indexeddb`
  - `IndexedDbAdapter`
  - `IndexedDbAdapterOptions`

- `@searchfn/adapter-meilisearch`
  - `MeilisearchAdapter`
  - `MeilisearchAdapterOptions`

- `@searchfn/adapter-elasticsearch`
  - `ElasticsearchAdapter`
  - `ElasticsearchAdapterOptions`

- `@searchfn/adapter-opensearch`
  - `OpenSearchAdapter`
  - `OpenSearchAdapterOptions`

- `@searchfn/adapter-postgres`
  - `PostgresAdapter`
  - `PostgresAdapterOptions`

- Utility alias handling
  - `redactSearchFnLogContext` SHOULD be exported by `@searchfn/adapter-contracts` OR a dedicated shared internal utility package for search adapters.
  - Decision lock for later phases: keep this symbol in `@searchfn/adapter-contracts` unless Phase 01 package boundaries require a shared internal package.

## Import Rewrite Canonical Rules

1. Type-only imports from legacy package map to `@searchfn/adapter-contracts`.
2. Concrete adapter class imports map to their specific leaf package.
3. Mixed imports MUST be split into multiple import statements.

### Example Rewrite

```ts
// before
import { MemoryAdapter, SearchAdapterError, type SearchAdapter } from "@searchfn/adapters";

// after
import { MemoryAdapter } from "@searchfn/adapter-memory";
import { SearchAdapterError, type SearchAdapter } from "@searchfn/adapter-contracts";
```

## Mapping Review Status

- Ambiguities: 0
- Blockers: 0
- Ready for Phase 01 scaffolding: Yes
