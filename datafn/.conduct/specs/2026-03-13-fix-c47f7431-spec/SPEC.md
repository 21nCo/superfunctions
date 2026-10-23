# Metadata
- Timestamp: 2026-03-13T14:19:34Z
- agent_name: unknown-agent
- model: gpt-5-codex
- launcher: Codex Desktop
- Workspace/project absolute path: /Users/serro/Documents/dev/n/superfunctions
- OS + shell: Darwin 25.3.0 arm64 / /bin/zsh
- Repo metadata:
  - branch: heads/next
  - commit: 5fe59b66a1ebf692ef723eb68f708e60a90de457
  - dirty: true (242 changed files)
- spec_folder: 2026-03-13-fix-c47f7431-spec
- spec_folder_path: /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec
- spec_type: fix
- spec_id: c47f7431
- Input paths read:
  - /Users/serro/.codex/skills/spec/SKILL.md
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issues/2026-03-12-k8m4x7r3-issue.md
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-12-change-p7x3k9m2-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/datafn/client/src/client.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/client/src/mutate.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/client/src/plugins/clientSearch.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/core/src/search-provider.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/search-provider.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/query/search.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/search/cross-resource.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/routes/search.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/client/src/lib/datafn.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/client/src/App.svelte
  - /Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/server/src/index.ts
- Audit-fix linkage: N/A (this is a fix spec from an issue report, not an audit report)

## Overview
Project name:
- Superfunctions `datafn`

One-sentence goal:
- Fix DataFn search integration so SearchFn adapters (especially IndexedDB client-side and Elasticsearch/OpenSearch server-side) work end-to-end with option parity (`prefix`, `fuzzy`, `fieldBoosts`), local-first behavior, and consistent index lifecycle updates.

Target users:
- DataFn maintainers.
- App teams using `@datafn/client`, `@datafn/server`, and `@searchfn/datafn-provider`.
- Example users of `datafn/examples/todo-app`.

Target environments:
- Browser client (IndexedDB, offline/online, sync mode and local-only mode).
- Node server (`@datafn/server`) with search provider and DB-native fallback.

Languages/packages required:
- TypeScript: `datafn/core`, `datafn/client`, `datafn/server`, `datafn/docs`, `datafn/examples/todo-app/*`.
- Search integration package: `searchfn/datafn-provider` (typing cleanup only if required by contract changes).

Existing systems it must integrate with:
- Existing `SearchProvider` contract and `createSearchProvider()` from `@searchfn/datafn-provider`.
- Existing client sync engine clone/pull search indexing.
- Existing server mutation `tryUpdateSearchIndex()` behavior.

Data model summary:
- Search operates over resource records (`id` + indexed fields).
- Cross-resource search returns `{ resource, id, score }` candidates then hydrates record data from storage/DB.

Security model:
- Search request validation uses deterministic `DFQL_INVALID` / `LIMIT_EXCEEDED` failures.
- No auth boundary changes are introduced; existing search authorization path remains authoritative.

Performance constraints:
- Existing caps remain (`query` length <= 1000, `limit` <= 10_000, `limitPerResource` <= 1_000, resource list <= 50).
- Local index updates on mutation must be non-blocking for network sync and fail-soft for reliability.

Non-goals:
- Replacing SearchFn adapter internals.
- Score normalization across different search engines.
- New ranking algorithms beyond currently supported adapter behavior.

Hard constraints:
- Must not regress existing optional behavior (all new search options are optional).
- Must preserve deterministic ordering for final search results.
- Must cover all issue-reported gaps (RC-1 through RC-8) with no deferred scope.

Assumptions and explicit questions:
- Assumption A1: This fix is TypeScript-focused; Python parity changes are not required for this issue because the reported failures are in TS client/server call paths.
- Assumption A2: `@searchfn/datafn-provider` already forwards options correctly; DataFn caller layers are the failing boundary.
- Question Q1 (non-blocking): Should `semantic` search type interpret `prefix/fuzzy` in all adapters, or pass-through and let adapter ignore unsupported combinations? This spec selects pass-through with adapter-defined behavior.

## Glossary
- `SearchProvider`: DataFn-facing abstraction used by client/server for `search`, `searchAll`, `updateIndices`, `initialize`, `dispose`.
- `Search options`: `prefix`, `fuzzy`, and `fieldBoosts` tuning options.
- `Local-first search`: Client search routing mode where local adapter search is primary even when remote is online.
- `Remote search`: Search executed through remote transport (`remote.search`) to server `/datafn/search`.
- `Cross-resource search`: Search returning scored IDs across multiple resources.
- `Per-resource search`: Query-level search constrained to a single resource (`DFQLQuery.search`).
- `Index lifecycle`: Create/rebuild/update/delete behavior for search indices over clone/pull/local mutations.
- `Provider-delegation mode` (plugin): `clientSearch` plugin mode where it delegates candidate resolution and indexing to configured `searchProvider` instead of MiniSearch internals.

## Goals / Non-goals
### Goals
1. DataFn MUST pass `prefix`, `fuzzy`, and `fieldBoosts` through every client/server caller boundary to SearchProvider.
2. DataFn client search MUST default to local-first behavior when a local search provider exists.
3. DataFn client mutation flows MUST update search indices for local writes (not only clone/pull sync ingestion).
4. Client search systems MUST be unified around SearchProvider when SearchProvider is configured.
5. Todo example app MUST demonstrate seamless local/server search behavior with parity options.
6. All issue-reported regressions MUST be covered by tests.

### Non-goals
1. This spec does not redesign SearchFn adapter scoring semantics.
2. This spec does not add new endpoint families beyond existing `query` and `search` endpoints.
3. This spec does not require changes to DB-native fallback algorithm beyond option passthrough compatibility handling.

## Public API
### 1) SearchProvider contract (DataFn core and server mirror)
```ts
type SearchTuning = {
  prefix?: boolean;
  fuzzy?: boolean | number;
  fieldBoosts?: Record<string, number>;
};

interface SearchProvider {
  readonly name: string;

  search(params: {
    resource: string;
    query: string;
    type?: "fullText" | "semantic";
    fields?: string[];
    limit?: number;
    prefix?: boolean;
    fuzzy?: boolean | number;
    fieldBoosts?: Record<string, number>;
    signal?: AbortSignal;
  }): Promise<string[]>;

  searchAll?(params: {
    query: string;
    resources?: string[];
    fields?: string[];
    limit?: number;
    limitPerResource?: number;
    prefix?: boolean;
    fuzzy?: boolean | number;
    fieldBoosts?: Record<string, number>;
    signal?: AbortSignal;
  }): Promise<Array<{ resource: string; id: string; score: number }>>;

  updateIndices(params: {
    resource: string;
    records: Record<string, unknown>[];
    operation: "upsert" | "delete";
  }): Promise<void>;
}
```

### 2) DFQL query search block (server execution type)
```ts
type DFQLQuerySearch = {
  query: string;
  type?: "fullText" | "semantic";
  fields?: string[];
  topK?: number;
  prefix?: boolean;
  fuzzy?: boolean | number;
  fieldBoosts?: Record<string, number>;
};
```

### 3) Client search request shape
```ts
type ClientSearchRequest = {
  query: string;
  resources?: string[];
  fields?: string[];
  limit?: number;
  limitPerResource?: number;
  filters?: Record<string, Record<string, unknown>>;
  select?: string[];
  prefix?: boolean;
  fuzzy?: boolean | number;
  fieldBoosts?: Record<string, number>;
  signal?: AbortSignal;
  source?: "auto" | "local" | "remote"; // optional, default "auto"
};
```

### 4) Server `/datafn/search` request body shape
```json
{
  "query": "string",
  "resources": ["resourceA", "resourceB"],
  "fields": ["title", "body"],
  "limit": 50,
  "limitPerResource": 25,
  "filters": { "resourceA": { "status": "active" } },
  "select": ["id", "title"],
  "prefix": true,
  "fuzzy": 0.2,
  "fieldBoosts": { "title": 2 }
}
```

## Data formats / protocol
### Canonical response envelopes
Success:
```json
{ "ok": true, "result": { "results": [] } }
```

Error:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Invalid request: prefix must be boolean",
    "details": { "path": "prefix" }
  }
}
```

### Canonical client `search()` local result shape
```json
{
  "results": [
    {
      "id": "todo:1",
      "resource": "todos",
      "score": 0.92,
      "data": { "id": "todo:1", "text": "testing" }
    }
  ]
}
```

### Canonical validation and failure behavior
- `query` MUST be non-empty trimmed string and length <= 1000.
- `resources` MUST be array of <=50 non-empty strings when provided.
- `limit` MUST be finite number >=1; effective limit MUST be capped at 10_000.
- `limitPerResource` MUST be finite number >=1; effective cap MUST be 1_000.
- `prefix` MUST be boolean when provided.
- `fuzzy` MUST be boolean or finite number >=0 when provided.
- `fieldBoosts` MUST be plain object of string keys and finite positive numeric values when provided.

Error code mapping:
- Validation type/range failures: `DFQL_INVALID`.
- Query length and list-size cap failures: `LIMIT_EXCEEDED`.
- Unsupported path (`no provider`, `remote unavailable`, invalid `source` for current runtime): `DFQL_UNSUPPORTED`.
- Aborted requests: `DFQL_ABORTED`.
- Unexpected runtime faults: `INTERNAL`.

## Semantics
### 1) Option propagation semantics
- Client `client.search()` MUST parse and forward `prefix`, `fuzzy`, `fieldBoosts` to:
  - local path: `searchProvider.searchAll()`.
  - remote path: `remote.search()` payload.
- Server query execution (`executeSearchQuery`) MUST forward the three options from `query.search` to `searchProvider.search`.
- Server cross-resource execution (`executeCrossResourceSearch`) MUST forward the three options from params to `searchProvider.searchAll`.
- Server `/datafn/search` route MUST extract the three options from request body and pass them into cross-resource search executor.

### 2) Client search routing semantics
Given `source` and runtime capabilities:
- `source = "auto"` (default):
  - if `searchProvider.searchAll` exists, execute local search first.
  - else if remote search is available and online, execute remote search.
  - else return `DFQL_UNSUPPORTED`.
- `source = "local"`:
  - MUST execute local provider path; if missing provider/searchAll, return `DFQL_UNSUPPORTED`.
- `source = "remote"`:
  - MUST execute remote path; if unavailable/offline, return `DFQL_UNSUPPORTED`.

This establishes local-first default while preserving explicit remote access.

### 3) Client index lifecycle semantics
For successful local mutation outcomes, DataFn client MUST invoke `searchProvider.updateIndices` with deterministic operation mapping:
- `insert`, `merge`, `replace`, `trash`, `restore`, `archive`, `unarchive` -> `operation: "upsert"` with post-mutation record payload.
- `delete` -> `operation: "delete"` with `{ id }` payload.
- Other ops (`share`, `unshare`, relation-only operations) -> no search index update.

Mutation flows covered:
- local-first optimistic path.
- transport-failure offline fallback path.
- debounced merge path after local optimistic write.

### 4) Fail-soft lifecycle semantics
- Search index update failures MUST NOT fail the parent mutation result.
- Failures MUST be observable via warning/error logging and include operation/resource context.

### 5) Client search unification semantics
- When a `searchProvider` is configured, `clientSearch` plugin MUST operate in provider-delegation mode:
  - candidate resolution uses provider (`search`), not MiniSearch.
  - index update path uses provider (`updateIndices`), not MiniSearch storage.
- MiniSearch-only mode MAY remain for backward compatibility when no `searchProvider` exists, but MUST be marked deprecated.

### 6) Todo example semantics
- Todo app client MUST demonstrate IndexedDB adapter with parity options.
- Todo app server MUST demonstrate Elasticsearch/OpenSearch adapter defaults with matching search options.
- UI search calls MUST include parity tuning options and local-first default behavior.

### 7) File-level boundary matrix (RC-1 through RC-8)
| RC ID | Boundary file(s) | Current drop/failure point | Locked expected behavior | Requirement IDs | Test vectors |
|---|---|---|---|---|---|
| RC-1 | `datafn/core/src/search-provider.ts`, `datafn/server/src/search-provider.ts` | Contract omits `prefix`, `fuzzy`, `fieldBoosts` in `search`/`searchAll` | Both contracts expose all three options with matching optional types in both methods. | CON-001 | TV-CON-001-P, TV-CON-001-N |
| RC-2 | `datafn/client/src/client.ts` | `client.search()` drops `prefix`, `fuzzy`, `fieldBoosts`; routing semantics ambiguous | Client validates and forwards all three options unchanged, keeps omitted values `undefined`, and applies `source` routing (`auto` local-first, explicit `local`/`remote`). | CON-003, CLI-001, CLI-002, CLI-003 | TV-CON-003-P, TV-CON-003-N, TV-CLI-001-P, TV-CLI-001-N, TV-CLI-002-P, TV-CLI-002-N, TV-CLI-003-P, TV-CLI-003-N |
| RC-3 | `datafn/server/src/execution/query/search.ts`, `datafn/server/src/execution/query/dfql.ts` | Per-resource query execution/type path drops option fields | Query `search` type includes all three options and execution forwards them to provider/native paths. | CON-002, SRV-001 | TV-CON-002-P, TV-CON-002-N, TV-SRV-001-P, TV-SRV-001-N |
| RC-4 | `datafn/server/src/execution/search/cross-resource.ts` | Cross-resource params/execution drop option fields | Cross-resource params include all three options and execution forwards them to `searchProvider.searchAll`. | CON-002, SRV-001 | TV-CON-002-P, TV-CON-002-N, TV-SRV-001-P, TV-SRV-001-N |
| RC-5 | `datafn/server/src/routes/search.ts` | Route body parser does not extract `prefix`, `fuzzy`, `fieldBoosts` | Route parser validates/extracts all three options and forwards them with canonical path-specific errors. | CON-003, SRV-002 | TV-CON-003-P, TV-CON-003-N, TV-SRV-002-P, TV-SRV-002-N |
| RC-6 | `datafn/client/src/mutate.ts`, `datafn/client/src/client.ts` | Local mutation lifecycle does not call `searchProvider.updateIndices` | Successful local mutations invoke deterministic `upsert`/`delete` updates; failures are fail-soft and observable. | IDX-001, IDX-002 | TV-IDX-001-P, TV-IDX-001-N, TV-IDX-002-P, TV-IDX-002-N |
| RC-7 | `datafn/client/src/plugins/clientSearch.ts` | Plugin hardcodes MiniSearch and bypasses provider lifecycle | Provider-delegation mode is authoritative when provider exists; legacy MiniSearch-only mode remains compatibility-only and deprecated. | UNI-001, UNI-002 | TV-UNI-001-P, TV-UNI-001-N, TV-UNI-002-P, TV-UNI-002-N |
| RC-8 | `searchfn/.conduct/specs/2026-03-12-change-p7x3k9m2-spec/SPEC.md` (scope reference), DataFn caller files above | Upstream searchfn spec does not include DataFn caller boundaries | This DataFn spec is authoritative for caller-boundary fixes and closes all RC-1..RC-7 runtime gaps without changing searchfn scope. | CON-001, CON-002, CON-003, TST-001 | TV-CON-001-P, TV-CON-001-N, TV-CON-002-P, TV-CON-002-N, TV-CON-003-P, TV-CON-003-N, TV-TST-001-P, TV-TST-001-N |

## Invariants
1. Final result ordering MUST remain deterministic: score descending, then resource ascending, then id ascending.
2. Existing optional search behavior MUST remain backward compatible when new fields are omitted.
3. Clone/pull indexing behavior MUST remain intact while adding local-mutation indexing.
4. Search lifecycle hooks (`initialize`, `dispose`) MUST continue to run exactly once per client lifecycle stage.
5. For identical storage snapshot and identical request payload, local search output ordering MUST be deterministic.

## Security
1. New option fields MUST be schema-validated and reject malformed inputs with canonical errors.
2. `fieldBoosts` payload MUST reject non-numeric and non-finite values.
3. Server MUST continue to apply authorization before returning search data.
4. Logs MUST avoid dumping entire record payloads for search-index failures; only resource/id/operation and error metadata SHOULD be logged.

## Limits/caps
- Query length cap: 1000 chars.
- Max resources: 50.
- Max `limit`: 10_000.
- Max `limitPerResource`: 1_000.
- Max `fieldBoosts` entries: 100 (to bound payload complexity).
- `fuzzy` numeric values: finite and >=0.

## Observability
1. Client SHOULD log routing decision (`local` vs `remote`) at debug level where logger exists.
2. Client MUST log search index update failures as non-fatal warnings with resource and operation.
3. Server SHOULD include search option forwarding in trace/debug logs when observability is enabled.
4. No logs may include full search document field values by default.

## Compatibility / versioning strategy
1. Search option fields are additive and optional; existing callers remain valid.
2. Local-first default is an intentional behavior change for `source="auto"`; explicit `source` enables controlled migration.
3. `clientSearch` MiniSearch-only mode remains available but deprecated when `searchProvider` is absent.
4. SearchFn spec `2026-03-12-change-p7x3k9m2-spec` remains valid; this DataFn spec closes caller-side gaps not covered there.

## Undefined / Explicitly user-deferred only
- Score equivalence across adapters (IndexedDB vs Elasticsearch/OpenSearch) is undefined and not required.
- Adapter-specific interpretation of `fuzzy` numeric distance beyond type validation is undefined and adapter-owned.
- New ranking/explain APIs are undefined and not required.
- No user-deferred items were requested in this scope.
