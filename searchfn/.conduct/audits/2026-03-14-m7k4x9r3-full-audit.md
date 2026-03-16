# SearchFn Documentation vs Code Audit Report

## Metadata

| Field | Value |
| --- | --- |
| **Timestamp** | 2026-03-14T19:45:00Z |
| **Agent** | unknown-agent |
| **Model** | claude-opus-4-6 |
| **Launcher** | Claude Code CLI |
| **Workspace** | `/Users/serro/Documents/dev/n/superfunctions` |
| **OS / Shell** | macOS / zsh |
| **Git Branch** | `next` |
| **Git Commit** | `5fe59b6` |

## Audit Scope

**Objective**: Comprehensive gap analysis of SearchFn documentation against the implemented codebase. Evaluate whether docs are thorough, accurate, and beginner-friendly.

**Docs audited** (16 pages):
- `searchfn/docs/content/docs/index.mdx`
- `searchfn/docs/content/docs/getting-started.mdx`
- `searchfn/docs/content/docs/architecture.mdx`
- `searchfn/docs/content/docs/reference/client.mdx`
- `searchfn/docs/content/docs/reference/server.mdx`
- `searchfn/docs/content/docs/reference/adapters/index.mdx`
- `searchfn/docs/content/docs/reference/adapters/memory.mdx`
- `searchfn/docs/content/docs/reference/adapters/indexeddb.mdx`
- `searchfn/docs/content/docs/reference/adapters/postgres.mdx`
- `searchfn/docs/content/docs/reference/adapters/meilisearch.mdx`
- `searchfn/docs/content/docs/reference/adapters/elastic-opensearch.mdx`
- `searchfn/docs/content/docs/integrations/datafn.mdx`
- `searchfn/docs/content/docs/operations/setup.mdx`
- `searchfn/docs/content/docs/operations/security.mdx`
- `searchfn/docs/content/docs/operations/observability.mdx`
- `searchfn/docs/content/docs/operations/troubleshooting.mdx`

**Code packages audited** (11 packages):
- `@searchfn/core`
- `@searchfn/adapter-contracts`
- `@searchfn/adapter-memory`
- `@searchfn/adapter-indexeddb`
- `@searchfn/adapter-postgres`
- `@searchfn/adapter-meilisearch`
- `@searchfn/adapter-elasticsearch`
- `@searchfn/adapter-opensearch`
- `@searchfn/client`
- `@searchfn/server`
- `@searchfn/datafn-provider`

---

## High-Level Findings

| Category | PASS | PARTIAL | FAIL | Total |
| --- | --- | --- | --- | --- |
| Package & Architecture | 6 | 1 | 0 | 7 |
| Adapter Contract & Types | 4 | 3 | 1 | 8 |
| Client API | 4 | 2 | 0 | 6 |
| Server API | 5 | 0 | 0 | 5 |
| Adapter-Specific Docs | 5 | 5 | 0 | 10 |
| Integration (DataFn) | 3 | 1 | 0 | 4 |
| Operations | 4 | 0 | 0 | 4 |
| Beginner-Friendliness | 2 | 4 | 0 | 6 |
| **Totals** | **33** | **16** | **1** | **50** |

**Overall verdict**: Documentation is solid for the happy path but has significant gaps in type-level detail, adapter-specific configuration, and advanced/beginner learning paths.

---

## Requirement-by-Requirement Results

### 1. Package & Architecture

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| PKG-001 | All 11 packages listed in docs | PASS | index.mdx and getting-started.mdx both list all 11 packages correctly |
| PKG-002 | Package descriptions accurate | PASS | Match package.json descriptions |
| PKG-003 | Architecture diagram accurate | PASS | Mermaid diagrams in index.mdx and architecture.mdx correctly show layers |
| PKG-004 | Built-in vs external distinction clear | PASS | Well-explained in architecture.mdx and adapters/index.mdx |
| PKG-005 | Data flow documented | PASS | architecture.mdx covers both built-in and external data flows |
| PKG-006 | Package layer table accurate | PASS | architecture.mdx table matches actual package structure |
| PKG-007 | Index page package count matches table | PARTIAL | index.mdx says "four packages" but the table lists 7+ rows (core, contracts, 2 built-in, 4 external, client, server, datafn-provider). The "four packages" claim is misleading — there are 11 distinct npm packages. |

### 2. Adapter Contract & Types

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| TYP-001 | `SearchAdapter` interface documented | PASS | architecture.mdx shows full interface with all 7 methods |
| TYP-002 | `SearchAdapterCapabilities` fully documented | PARTIAL | **`prefix` capability missing from docs.** Code defines `prefix?: boolean` in `SearchAdapterCapabilities` (adapter-contracts/src/index.ts:60), but architecture.mdx capabilities table only lists: persistent, searchAll, fuzzy, fieldBoosts, maxBatchSize. All 6 adapters declare `prefix: true` in their capabilities. |
| TYP-003 | `SearchParams` type documented | PASS | client.mdx search method table covers all SearchParams fields |
| TYP-004 | `SearchAllParams` type documented | PASS | client.mdx searchAll method table covers all fields |
| TYP-005 | `SearchDefaults` type documented | FAIL | **Not documented anywhere.** Code defines `SearchDefaults` (adapter-contracts/src/index.ts:78-82) with `fuzzy`, `prefix`, `fieldBoosts` fields. All 6 adapters accept `defaults?: SearchDefaults` in their constructor options. Client docs mention `defaults` on `SearchClientConfig` but only document `limit`, `limitPerResource`, `fuzzy` — missing `prefix` and `fieldBoosts` from adapter-level defaults. |
| TYP-006 | `SearchAdapterConfig` base type documented | PARTIAL | Code defines `SearchAdapterConfig` with `pipeline` and `defaults` fields (adapter-contracts/src/index.ts:84-87). Memory adapter docs mention `pipeline` but not `defaults`. No adapter doc mentions the shared `SearchAdapterConfig` base type. |
| TYP-007 | `SearchAdapterError` class documented | PARTIAL | Error codes listed in architecture.mdx and troubleshooting.mdx, but `SearchAdapterError` class API (`code`, `message` properties, constructor signature) not documented. The `SEARCH_ADAPTER_DISPOSED` constant is only referenced obliquely in troubleshooting.mdx. |
| TYP-008 | `InitializeParams` / `InitializeResourceConfig` documented | PASS | client.mdx initialize section covers the type |

### 3. Client API

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| CLI-001 | `createSearchClient` factory documented | PASS | Full config + usage example |
| CLI-002 | All SearchClient methods documented | PASS | initialize, index, search, searchAll, remove, clear, dispose, adapterInfo |
| CLI-003 | Convenience constructors documented | PASS | `createMemorySearchClient`, `createIndexedDbSearchClient` with examples |
| CLI-004 | Validation limits documented | PASS | All 5 limits with defaults |
| CLI-005 | `SearchClientDefaults` complete | PARTIAL | Docs show `limit`, `limitPerResource`, `fuzzy` but **missing `prefix` and `fieldBoosts`** which are valid in `SearchClientDefaults` (client/src/client.ts inherits from adapter SearchDefaults plus its own limit fields) |
| CLI-006 | `SearchClientValidationError` documented | PARTIAL | Mentioned at bottom of client.mdx ("throws SearchClientValidationError with code and optional details.path") but **error code values** (`DFQL_INVALID`, `LIMIT_EXCEEDED`) are not listed on the client page — user must find them in architecture.mdx or troubleshooting.mdx |

### 4. Server API

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| SRV-001 | `createSearchFnServer` factory documented | PASS | Full config with types |
| SRV-002 | All 6 endpoints documented | PASS | Status, index, search, search-all, remove, clear with request/response examples |
| SRV-003 | `ServerLimits` documented | PASS | All 6 limits with defaults |
| SRV-004 | `authorize` callback documented | PASS | Including all 6 action names |
| SRV-005 | `SearchFnLogger` interface documented | PASS | 4 methods shown, log fields table, secret redaction keys |

### 5. Adapter-Specific Docs

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| ADP-001 | MemoryAdapter config complete | PARTIAL | Documents `pipeline` option but **missing `defaults` option**. Code: `SearchAdapterConfig = { pipeline, defaults }` |
| ADP-002 | MemoryAdapter capabilities complete | PARTIAL | Lists 4 capabilities but **missing `prefix: true`** |
| ADP-003 | IndexedDB config complete | PARTIAL | Documents `dbName`, `pipeline`, `cache.terms`, `cache.vectors` but **missing `defaults` option** |
| ADP-004 | IndexedDB capabilities complete | PARTIAL | Lists 4 capabilities but **missing `prefix: true`** |
| ADP-005 | Postgres config complete | PASS | All options documented including retry policy fields |
| ADP-006 | Postgres capabilities complete | PASS | Correctly shows fieldBoosts: No |
| ADP-007 | Meilisearch config complete | PASS | All options documented |
| ADP-008 | Meilisearch capabilities complete | PASS | Correctly shows fieldBoosts: No |
| ADP-009 | Elasticsearch/OpenSearch config complete | PASS | All options documented, dual-engine pattern clear |
| ADP-010 | `getPostgresMigrationSQL` documented | PARTIAL | Mentioned in postgres.mdx setup section but **no parameter documentation, no return type, no example of what the SQL creates**. Beginner would not know what tables/indexes are created. |

### 6. Integration (DataFn Provider)

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| INT-001 | `createSearchProvider` factory documented | PASS | Both server and client usage examples |
| INT-002 | Provider methods documented | PASS | All 5 methods listed with descriptions |
| INT-003 | Behavior details documented | PASS | Abort signals, searchAll fallback, ID coercion, concurrency limit (10) |
| INT-004 | `CreateSearchProviderOptions` fully documented | PARTIAL | `resourceFields` documented. However, **internal default limits** (limit: 50, limitPerResource: 50) set by the provider factory are not documented. A user might expect the adapter's defaults to apply, but the provider overrides them. |

### 7. Operations

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| OPS-001 | Setup/deployment guide | PASS | 6-step deployment, env vars, resilience config |
| OPS-002 | Security docs | PASS | Authorization, secret redaction keys, credential management |
| OPS-003 | Observability docs | PASS | Log events, log fields, health endpoint, failure classification, alerting recs |
| OPS-004 | Troubleshooting docs | PASS | Error reference, common issues, backend-specific playbooks |

### 8. Beginner-Friendliness Assessment

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| BEG-001 | Quick start is copy-pasteable | PASS | getting-started.mdx has a 5-step example that works out of the box |
| BEG-002 | Adapter selection guidance | PASS | adapters/index.mdx has comparison tables and "Choosing an Adapter" section |
| BEG-003 | PipelineOptions explained for customization | PARTIAL | architecture.mdx lists the 5 pipeline stages but **`PipelineOptions` type is never documented**. Code exposes: `enableStemming`, `stopWords`, `customStages`, `language`, `stemmer`, `enableEdgeNGrams`, `edgeNGramMinLength`, `edgeNGramMaxLength`, `edgeNGramFieldConfig`. Memory and IndexedDB adapters accept `pipeline: PipelineOptions` but a user has no reference for what options are available. |
| BEG-004 | Custom pipeline stage example | PARTIAL | No example of creating a `customStages` pipeline stage. The `PipelineStage` interface (name + execute) is only in code. A beginner wanting to add a custom tokenizer or filter has no docs guidance. |
| BEG-005 | End-to-end example with real adapter | PARTIAL | No end-to-end example showing Postgres setup from `getPostgresMigrationSQL()` through indexing to search. Server quick start uses MemoryAdapter only. |
| BEG-006 | `@searchfn/core` exports documented | PARTIAL | Core is described architecturally but its **public API** (`PipelineEngine`, `Indexer`, `QueryEngine`, `LruCache`, `scorePostings`, `fuzzyExpand`, `encodePostings`) is not documented. Advanced users wanting to use core directly (e.g., custom adapter) have no reference. |

---

## Critical Gaps Summary (Ranked by Impact)

### Gap 1: `prefix` capability missing from all documentation
- **Severity**: Medium
- **Impact**: All 6 adapters declare `prefix: true` in capabilities. The `prefix` field exists in `SearchAdapterCapabilities`, `SearchParams`, `SearchAllParams`, and `SearchDefaults`. architecture.mdx's capabilities table omits it entirely. Every adapter capabilities table also omits it.
- **Files**: adapter-contracts/src/index.ts:60, architecture.mdx:124-139, all adapter doc pages
- **Fix**: Add `prefix` row to capabilities interface docs and all adapter capability tables

### Gap 2: `SearchDefaults` type not documented
- **Severity**: Medium-High
- **Impact**: Every adapter accepts `defaults?: SearchDefaults` in its constructor. This lets users set default `fuzzy`, `prefix`, and `fieldBoosts` values at the adapter level so they don't need to pass them on every search call. This is entirely undocumented — a user would only discover it by reading source code.
- **Files**: adapter-contracts/src/index.ts:78-87, all adapter constructor options
- **Fix**: Document `SearchDefaults` type and add `defaults` to every adapter config table

### Gap 3: `PipelineOptions` type not documented
- **Severity**: Medium
- **Impact**: Memory and IndexedDB adapters accept `pipeline: PipelineOptions` but no docs explain what options are available. The pipeline has 9 configurable fields including stemming, stop words, edge n-grams, and custom stages.
- **Files**: core/src/pipeline/types.ts:12-31
- **Fix**: Create a PipelineOptions reference section in architecture.mdx or a dedicated page

### Gap 4: `@searchfn/core` public API not documented
- **Severity**: Low-Medium
- **Impact**: Core exports `PipelineEngine`, `Indexer`, `QueryEngine`, `LruCache`, `scorePostings`, `fuzzyExpand`, `encodePostings`. Advanced users building custom adapters or pipeline stages have no reference.
- **Files**: core/src/index.ts
- **Fix**: Add a core API reference page

### Gap 5: Client `defaults` missing `prefix` and `fieldBoosts`
- **Severity**: Medium
- **Impact**: `SearchClientDefaults` inherits `prefix` and `fieldBoosts` from adapter-level defaults. Client docs only show `limit`, `limitPerResource`, `fuzzy`. User cannot set default prefix/fieldBoosts without reading source.
- **Files**: client/src/client.ts, reference/client.mdx
- **Fix**: Add `prefix` and `fieldBoosts` to client defaults table

### Gap 6: `getPostgresMigrationSQL` lacks detail
- **Severity**: Low-Medium
- **Impact**: Mentioned but not explained. Beginner has no idea what tables/indexes it creates or whether it accepts parameters.
- **Files**: adapter-postgres/src/postgres.ts, reference/adapters/postgres.mdx
- **Fix**: Document parameters, return value, and describe the tables/indexes created

### Gap 7: No custom pipeline stage example
- **Severity**: Low
- **Impact**: `PipelineStage` interface exists in code but no example in docs shows how to write and register a custom stage.
- **Files**: core/src/pipeline/types.ts:32-35
- **Fix**: Add a "Custom Pipeline Stages" section with example

### Gap 8: DataFn provider default limits not documented
- **Severity**: Low
- **Impact**: Provider factory defaults limit to 50 and limitPerResource to 50 internally, which may surprise users expecting their adapter or client defaults to flow through.
- **Files**: datafn-provider/src/index.ts:51,105
- **Fix**: Document the provider's internal defaults

### Gap 9: Index page "four packages" count is wrong
- **Severity**: Low
- **Impact**: Cosmetic inconsistency — text says "four packages" but table lists 7+ conceptual groups (11 npm packages).
- **Files**: docs/content/docs/index.mdx:52
- **Fix**: Update text to match actual package count

### Gap 10: `SearchAdapterError` class API not documented
- **Severity**: Low
- **Impact**: Error codes are listed but the class itself (constructor, `code` property) is not documented. Users catching errors don't know the shape.
- **Files**: adapter-contracts/src/index.ts:91-99
- **Fix**: Add error class reference to architecture.mdx or troubleshooting.mdx

---

## Recommendations (Ranked)

1. **Document `SearchDefaults` type and add `defaults` to every adapter config table.** This is the highest-impact gap — it affects all 6 adapters and the client.

2. **Add `prefix` to capabilities interface docs and all adapter capability tables.** A single missing capability field propagates across 8 documentation locations.

3. **Document `PipelineOptions` with all 9 fields.** Add to architecture.mdx or create a dedicated reference page. Include a custom pipeline stage example.

4. **Add `prefix` and `fieldBoosts` to client defaults documentation.** Update client.mdx config table.

5. **Expand `getPostgresMigrationSQL` docs** with parameters, return type, and description of created tables/indexes.

6. **Document `@searchfn/core` public API** for advanced users building custom adapters.

7. **Add end-to-end Postgres example** showing migration SQL execution through indexing to search.

8. **Document `SearchAdapterError` class** shape and constructor.

9. **Fix index.mdx "four packages" text** to match actual count.

10. **Document DataFn provider internal defaults** (limit: 50, limitPerResource: 50).

---

## Appendix: Commands Executed

- `glob` for file discovery across searchfn/docs/ and searchfn/*/src/
- `read` on all 16 doc pages and key source files
- `grep` for `SearchDefaults`, `prefix`, `PipelineOptions` across codebase
- Agent-based full codebase exploration of all 11 packages
- No code was modified during this audit
