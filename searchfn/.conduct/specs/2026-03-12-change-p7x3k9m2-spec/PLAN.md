# PLAN: Search Query Options — Construct-Time Defaults & Query-Time Overrides

## Architecture Sketch

```
adapter-contracts        ← SearchDefaults, prefix on SearchParams/SearchAllParams/Capabilities
    │
    ├── adapter-memory          ← resolve prefix from defaults/params, include prefix tokens
    ├── adapter-indexeddb       ← same as memory (shared pipeline engine)
    ├── adapter-postgres        ← resolve prefix, use :* operator
    ├── adapter-elasticsearch   ← resolve prefix, add phrase_prefix clause
    │     └── adapter-opensearch ← inherits from elasticsearch
    └── adapter-meilisearch     ← advertise prefix capability, accept defaults
    │
    ├── client                  ← SearchClientDefaults gains prefix + fieldBoosts, resolve in createSearchClient
    ├── server                  ← routes pass prefix through
    └── datafn-provider         ← forward fuzzy, prefix, fieldBoosts to adapter
```

## Dependency Graph

```
PHASE_00: adapter-contracts (types only — no runtime changes)
    ↓
PHASE_01: elasticsearch + opensearch adapters (P0 — user-reported issue)
    ↓ (parallel with)
PHASE_02: client + server + datafn-provider (passthrough layers)
    ↓
PHASE_03: memory + indexeddb + postgres + meilisearch adapters (P1 — remaining adapters)
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|-------|------|---------------------|--------------|
| PHASE_00 | Contract types | `prefix`, `SearchDefaults` types exported | TypeScript compiles, all existing tests pass |
| PHASE_01 | ES/OS prefix matching | Elasticsearch/OpenSearch support prefix + defaults | Unit tests for query construction, integration test with real ES (if available) |
| PHASE_02 | Passthrough layers | Client, server, datafn-provider pass prefix/defaults through | Unit tests verifying params forwarded to adapter |
| PHASE_03 | Remaining adapters | Memory, IndexedDB, Postgres, Meilisearch support prefix + defaults | Unit tests per adapter |

## Definition of Done (Global)

No phase is complete unless:
1. All new code compiles without TypeScript errors.
2. All existing tests in affected packages pass.
3. New tests for the phase's requirements pass.
4. No regressions in dependent packages.
