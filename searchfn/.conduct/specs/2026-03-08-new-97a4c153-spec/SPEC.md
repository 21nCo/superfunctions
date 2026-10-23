# SearchFn Full Rewrite + Productionization SPEC

## Metadata
- **Timestamp**: 2026-03-08T17:26:13Z
- **Agent Name**: unknown-agent
- **Model**: gpt-5-codex
- **Launcher**: Codex Desktop
- **Workspace/Project Path**: /Users/serro/Documents/dev/n/superfunctions
- **OS + Shell**: Darwin 25.3.0 (arm64) + zsh
- **Git Branch**: next
- **Git Commit**: 635bf2853807d9d76dba07a460dd0594f57d9147
- **Git Dirty Status**: dirty (251 changed files)
- **Spec Folder Name**: 2026-03-08-new-97a4c153-spec
- **Spec Folder Full Path**: /Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-08-new-97a4c153-spec
- **Spec Type**: new
- **Spec ID**: 97a4c153
- **Input Paths Read**:
  - /Users/serro/.codex/skills/spec/SKILL.md
  - Conversation intent in this thread (searchfn server/client rewrite + adapter implementation + docs + production readiness)
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/server/src/server.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/server/src/indexing.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/server/src/search.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/client/src/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/memory.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/indexeddb.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/meilisearch.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/elasticsearch.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/postgres.ts
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/datafn-provider/src/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/server.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/client/src/client.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/client/src/sync/engine.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/client/src/plugins/clientSearch.ts
  - /Users/serro/Documents/dev/n/superfunctions/recfn/server/src/integrations/searchfn.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/docs/package.json
  - /Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/layout.tsx
  - /Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/layout.config.tsx
  - /Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/docs/layout.tsx
  - /Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/docs/[[...slug]]/page.tsx

## Overview
SearchFn MUST be rewritten into a clear layered architecture with no backward-compatibility constraints:
1. `@searchfn/adapters` is the runtime boundary and MUST contain fully implemented server-grade adapters (Postgres, Meilisearch, Elasticsearch/OpenSearch) plus Memory and IndexedDB adapters.
2. `@searchfn/server` MUST become a thin HTTP transport over any `SearchAdapter` using `@superfunctions/http`.
3. `@searchfn/client` MUST become a thin convenience layer for browser/client apps that directly use SearchFn without DataFn.
4. `@searchfn/datafn-provider` MUST remain the bridge to DataFn SearchProvider and be aligned to the rewritten adapter contract.
5. Internal monorepo consumers MUST be migrated to new APIs, and legacy code paths MUST be removed.
6. SearchFn documentation MUST be rebuilt as a Fumadocs site with shared visual/theme primitives reusable by DataFn and future docs sites.
7. Production-readiness capabilities (security, observability, resilience, conformance tests, performance gates) MUST be shipped as part of this effort.

This is a full-scope rewrite-and-cleanup spec. No legacy compatibility or legacy docs are required.

## Glossary
- **SearchAdapter**: Primary runtime contract used by client/server/provider integrations.
- **Thin Server Layer**: `@searchfn/server` package that validates request envelopes and delegates to a supplied adapter instance.
- **Thin Client Layer**: `@searchfn/client` package that wraps adapter APIs into ergonomic app-facing methods and constructors.
- **Adapter Conformance Suite**: Shared test contract that every adapter implementation MUST pass.
- **Elastic-Compatible Adapter**: One implementation that supports both Elasticsearch and OpenSearch via config.
- **SearchProvider Bridge**: `@searchfn/datafn-provider` factory that converts SearchAdapter into DataFn SearchProvider.
- **Docs Theme Package**: Shared package of docs tokens/layout helpers reused by DataFn docs, SearchFn docs, and future docs sites.

## Goals / Non-goals
### Goals
- Deliver complete adapter implementations for Postgres, Meilisearch, and Elasticsearch/OpenSearch.
- Replace stale `@searchfn/server` logic with adapter-driven HTTP endpoints.
- Replace monolithic `@searchfn/client` legacy exports with thin API wrappers.
- Migrate in-repo usage to rewritten APIs.
- Remove legacy implementation/code/docs.
- Deliver comprehensive Fumadocs site for SearchFn and shared theming across docs sites.
- Enforce production-readiness quality gates.

### Non-goals
- Backward compatibility with old SearchFn API surfaces.
- Preserving deprecated class names or migration helpers.
- Supporting unpublished legacy docs.
- Implementing vector/semantic ranking engines beyond current full-text scope.

## Public API
### 1) `@searchfn/adapters` contract
```ts
export interface SearchDocument {
  id: string | number;
  fields: Record<string, string>;
}

export interface IndexParams {
  resource: string;
  documents: SearchDocument[];
  signal?: AbortSignal;
}

export interface SearchParams {
  resource: string;
  query: string;
  fields?: string[];
  limit?: number;
  fuzzy?: boolean | number;
  fieldBoosts?: Record<string, number>;
  signal?: AbortSignal;
}

export interface SearchAllParams {
  query: string;
  resources?: string[];
  fields?: string[];
  limit?: number;
  limitPerResource?: number;
  fuzzy?: boolean | number;
  fieldBoosts?: Record<string, number>;
  signal?: AbortSignal;
}

export interface SearchAllResult {
  resource: string;
  id: string | number;
  score: number;
}

export interface SearchAdapter {
  readonly name: string;
  readonly capabilities?: {
    persistent?: boolean;
    searchAll?: boolean;
    fuzzy?: boolean;
    fieldBoosts?: boolean;
    maxBatchSize?: number;
  };

  initialize?(params: { resources: Array<{ name: string; searchFields: string[] }> }): Promise<void>;
  index(params: IndexParams): Promise<void>;
  search(params: SearchParams): Promise<Array<string | number>>;
  searchAll?(params: SearchAllParams): Promise<SearchAllResult[]>;
  remove(params: { resource: string; ids: Array<string | number>; signal?: AbortSignal }): Promise<void>;
  clear(resource: string, signal?: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}
```

### 2) `@searchfn/server` thin layer
```ts
export interface SearchFnServerConfig<TContext = unknown> {
  adapter: SearchAdapter;
  basePath?: string; // default: "/searchfn"
  limits?: {
    maxPayloadBytes?: number; // default: 1_048_576
    maxQueryLength?: number; // default: 1000
    maxResourcesPerSearchAll?: number; // default: 50
    maxLimit?: number; // default: 10_000
    maxLimitPerResource?: number; // default: 1_000
    maxIndexBatch?: number; // default: 10_000
  };
  authorize?: (
    ctx: TContext,
    action: "status" | "index" | "search" | "searchAll" | "remove" | "clear",
    payload: unknown,
  ) => Promise<boolean> | boolean;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
    debug(message: string, context?: Record<string, unknown>): void;
  };
}

export interface SearchFnServer<TContext = unknown> {
  router: import("@superfunctions/http").Router<TContext>;
  close(): Promise<void>; // delegates adapter.dispose if defined
}

export async function createSearchFnServer<TContext = unknown>(
  config: SearchFnServerConfig<TContext>,
): Promise<SearchFnServer<TContext>>;
```

Endpoints exposed by `createSearchFnServer`:
- `GET {basePath}/status`
- `POST {basePath}/index`
- `POST {basePath}/search`
- `POST {basePath}/search-all`
- `POST {basePath}/remove`
- `POST {basePath}/clear`

### 3) `@searchfn/client` thin layer
```ts
export interface SearchClient {
  initialize?(params: { resources: Array<{ name: string; searchFields: string[] }> }): Promise<void>;
  index(params: IndexParams): Promise<void>;
  search(params: SearchParams): Promise<Array<string | number>>;
  searchAll(params: SearchAllParams): Promise<SearchAllResult[]>;
  remove(params: { resource: string; ids: Array<string | number>; signal?: AbortSignal }): Promise<void>;
  clear(resource: string, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
  adapterInfo(): { name: string; capabilities?: SearchAdapter["capabilities"] };
}

export function createSearchClient(config: {
  adapter: SearchAdapter;
  defaults?: { limit?: number; limitPerResource?: number; fuzzy?: boolean | number };
}): SearchClient;

export function createMemorySearchClient(config?: {
  adapterConfig?: import("@searchfn/adapters").SearchAdapterConfig;
  defaults?: { limit?: number; limitPerResource?: number; fuzzy?: boolean | number };
}): SearchClient;

export function createIndexedDbSearchClient(config?: {
  adapterConfig?: import("@searchfn/adapters").IndexedDbAdapterOptions;
  defaults?: { limit?: number; limitPerResource?: number; fuzzy?: boolean | number };
}): SearchClient;
```

### 4) `@searchfn/datafn-provider`
```ts
export function createSearchProvider(
  adapter: SearchAdapter,
  options?: { resourceFields?: Record<string, string[]> },
): import("@datafn/core").SearchProvider;
```

The bridge MUST pass `signal`, map adapter IDs to strings, and provide deterministic fallback for adapters without `searchAll`.

## Data formats / protocol
### Canonical HTTP envelope
Success:
```json
{
  "ok": true,
  "result": {}
}
```

Error:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Search query must not be empty",
    "details": { "path": "query" }
  }
}
```

### Endpoint payloads
`POST /searchfn/index`
```json
{ "resource": "tasks", "documents": [{ "id": "t1", "fields": { "title": "hello" } }] }
```

`POST /searchfn/search`
```json
{ "resource": "tasks", "query": "hello", "limit": 20, "fuzzy": true }
```

`POST /searchfn/search-all`
```json
{ "query": "hello", "resources": ["tasks", "notes"], "limit": 20, "limitPerResource": 10 }
```

`POST /searchfn/remove`
```json
{ "resource": "tasks", "ids": ["t1", "t2"] }
```

`POST /searchfn/clear`
```json
{ "resource": "tasks" }
```

### Error codes
- `DFQL_INVALID` for malformed input.
- `LIMIT_EXCEEDED` for caps violations.
- `DFQL_ABORTED` for aborted requests.
- `FORBIDDEN` for authorization failure.
- `DFQL_UNSUPPORTED` for unavailable operation on adapter capability mismatch.
- `INTERNAL` for unexpected failures.

## Semantics
- Adapters MUST treat `index` as upsert per `(resource,id)`.
- `search` MUST return ranked IDs only for a single resource.
- `searchAll` MUST merge resource results and return deterministic global order.
- Deterministic order MUST be:
  1) score descending
  2) resource ascending (lexical)
  3) id ascending (stringified lexical)
- Thin client/server wrappers MUST clamp limits and validate query/resource shapes before adapter calls.
- Thin server MUST be stateless aside from adapter lifecycle and optional metrics counters.
- DataFn provider MUST update indices on mutation upsert/delete and initialize with schema `indices.search` fields.

## Invariants
- No hidden fallback to legacy classes or plugin scanning.
- No runtime dependence of `@searchfn/client` on removed legacy modules.
- One source of truth for SearchAdapter contract in `@searchfn/adapters/src/types.ts`.
- Elasticsearch/OpenSearch behavior MUST remain deterministic regardless of backend tie ordering.
- All adapter implementations MUST pass the shared conformance suite.

## Security
- Server wrapper MUST support authorization callback before mutation/search operations.
- Sensitive config (`apiKey`, `password`, bearer token, connection string) MUST NOT be logged in plaintext.
- HTTP adapters MUST default to TLS URLs in docs/examples and MUST expose explicit insecure opt-in only for local dev.
- Input validation MUST reject empty query, invalid limits, and invalid resource arrays.

## Limits/caps
Default caps (configurable in server/client wrappers):
- `maxPayloadBytes`: 1_048_576
- `maxQueryLength`: 1000
- `maxResourcesPerSearchAll`: 50
- `maxLimit`: 10_000
- `maxLimitPerResource`: 1_000
- `maxIndexBatch`: 10_000 documents per request

## Observability
- Server and adapters MUST emit structured logs for: request start/end, validation errors, adapter errors, retries, and lifecycle events.
- Log fields MUST include: `operation`, `adapter`, `resource`, `durationMs`, `success`, `errorCode` (if any).
- Metrics counters/gauges/histograms MUST be exposed through pluggable hooks (not hard dependency on a specific metrics backend).
- Production docs MUST include an observability reference page with exact event names and fields.

## Compatibility / versioning strategy
- This rewrite is intentionally breaking.
- Legacy API exports, compatibility aliases, migration helpers, and legacy docs MUST be removed.
- Semver baseline after rewrite SHOULD start at a new minor/major boundary determined by repo maintainers, but this spec assumes unpublished consumers and permits direct replacement.

## Assumptions
- Node runtime for server adapters is >=18.18.
- Browser runtime for IndexedDB adapter and thin client includes `AbortController`.
- OpenSearch compatibility can be delivered via the same request/response contract as Elasticsearch with configurable dialect.

## Open questions (non-blocking for spec)
1. Should the shared docs theme package live in `packages/docs-theme` or `packages/docs-ui`? (Spec uses `packages/docs-theme`.)
2. Should server auth callback receive raw request metadata (headers/path) in addition to payload/context? (Spec keeps current DataFn-style callback shape.)

## Undefined / Explicitly user-deferred only
- No user-deferred items were provided.
- Everything not explicitly specified in this spec is Undefined and not required.
