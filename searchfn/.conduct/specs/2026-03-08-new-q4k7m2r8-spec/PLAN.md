# PLAN — SearchFn Adapter Architecture + DataFn SearchProvider Integration

## Architecture Sketch

```
┌─────────────────────────────────────────────────────────────┐
│                    @searchfn/core                            │
│  PipelineEngine, Indexer, DocumentStatsManager, scorePostings│
│  QueryEngine, LruCache, IndexedDbManager, levenshtein       │
│  All types (DocId, Token, PipelineOptions, etc.)            │
└──────────────────────┬──────────────────────────────────────┘
                       │ used by
┌──────────────────────▼──────────────────────────────────────┐
│                  @searchfn/adapters                          │
│  SearchAdapter interface                                     │
│  MemoryAdapter (uses core Pipeline, Indexer, Scoring)       │
│  IndexedDbAdapter (uses core + IndexedDbManager)            │
│  MeilisearchAdapter (stub)                                   │
│  ElasticsearchAdapter (stub)                                │
│  PostgresAdapter (stub)                                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ consumed by
┌──────────────────────▼──────────────────────────────────────┐
│              @searchfn/datafn-provider                       │
│  createSearchProvider(adapter, opts?) → SearchProvider       │
│  Pure method bridging — no hooks, no runsOn                 │
│  searchAll fallback when adapter lacks native searchAll     │
└──────────────────────┬──────────────────────────────────────┘
                       │ passed into
┌──────────────────────▼──────────────────────────────────────┐
│                @datafn/server + @datafn/client               │
│  SearchProvider interface (dedicated, NOT DatafnPlugin)     │
│  searchProvider config slot on DatafnServerConfig/ClientConfig│
│  Built-in wiring: mutation → updateIndices, sync → updateIndices│
│  server.search() method                                      │
│  client.search() method                                      │
│  POST /datafn/search route                                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   @searchfn/client                           │
│  Backward compat re-exports from @searchfn/core + adapters  │
│  InMemorySearchFn, SearchFn, SearchEngine, etc.             │
└─────────────────────────────────────────────────────────────┘
```

## Dependency Graph

```
@searchfn/core             ← no external deps (pure engine)
    ↑
@searchfn/adapters         ← depends on @searchfn/core
    ↑
@searchfn/datafn-provider  ← depends on @searchfn/adapters + @datafn/core (types only)
    ↑
@datafn/server             ← depends on @datafn/core (SearchProvider type)
@datafn/client             ← depends on @datafn/core (SearchProvider type)

@searchfn/client           ← depends on @searchfn/core + @searchfn/adapters (re-exports)
```

**Build order**: core → adapters → datafn-provider → (datafn server/client changes) → client (compat)

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| PHASE_00 | Extract @searchfn/core package | Core internals as independent package; all existing tests pass | `npm test` in core; TypeScript compiles |
| PHASE_01 | SearchAdapter interface + MemoryAdapter | Unified adapter interface; memory adapter with full search | Unit tests for MemoryAdapter against all CORE/MEM test vectors |
| PHASE_02 | IndexedDB Adapter | Persistent browser search via adapter interface | Unit tests with fake-indexeddb for IDB test vectors |
| PHASE_03 | SearchProvider interface + DataFn config slot + codebase migration | SearchProvider type defined; searchProvider config on DatafnServerConfig/DatafnClientConfig; delete SearchFnPlugin, remove plugin scanning for search | All existing datafn tests pass; grep confirms no old references |
| PHASE_04 | createSearchProvider factory | Factory bridging adapters to SearchProvider; deterministic searchAll fallback and resource-resolution rules | Unit tests for factory, delegation, fallback ordering, and fallback validation |
| PHASE_05 | Cross-resource .search() + /datafn/search route + built-in wiring | server.search(), client.search(), HTTP route, canonical fallback/error behavior, end-state search use-case contracts, mutation/sync → index wiring, clone rebuild lifecycle | Integration tests for route; unit tests for search method, determinism/error contracts, and sync rebuild behavior |
| PHASE_06 | External adapter stubs + @searchfn/client compat | Meili/ES/PG stubs; backward compat re-exports from @searchfn/client with advanced API + export-baseline checks | Import/API-manifest tests; existing @searchfn/client tests pass |

## Definition of Done (Global)

No phase is complete unless:
1. All verification steps for that phase pass
2. TypeScript compilation succeeds with no errors across affected packages
3. No regressions in existing test suites
4. Files listed in deliverables exist and contain the specified content
5. Requirements covered by the phase have passing test vectors
