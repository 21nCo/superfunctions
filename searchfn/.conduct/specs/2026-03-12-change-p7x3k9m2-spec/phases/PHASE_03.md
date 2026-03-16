# PHASE_03 — Remaining Adapters: Memory, IndexedDB, Postgres, Meilisearch

## Phase Goal

Implement prefix matching and construct-time defaults in all remaining adapters.

## In Scope

- Memory adapter: prefix token inclusion, SearchDefaults from config
- IndexedDB adapter: prefix token inclusion, SearchDefaults from options
- Postgres adapter: prefix via `:*` operator, SearchDefaults from options
- Meilisearch adapter: advertise prefix capability, SearchDefaults from options

## Out of Scope

- Elasticsearch/OpenSearch (done in Phase 01)
- Client/server/datafn-provider (done in Phase 02)

## Deliverables

- `searchfn/adapter-memory/src/index.ts` — modified
- `searchfn/adapter-memory/__tests__/memory.test.ts` — modified (new tests)
- `searchfn/adapter-indexeddb/src/index.ts` — modified
- `searchfn/adapter-indexeddb/__tests__/indexeddb.test.ts` — modified (new tests)
- `searchfn/adapter-postgres/src/postgres.ts` — modified
- `searchfn/adapter-postgres/__tests__/postgres.test.ts` — modified (new tests)
- `searchfn/adapter-meilisearch/src/meilisearch.ts` — modified
- `searchfn/adapter-meilisearch/__tests__/meilisearch.test.ts` — modified (new tests)

## Requirements Covered

ADP-005, ADP-006, ADP-007, ADP-008, ADP-009, ADP-010, ADP-011, ADP-012

## Implementation Tasks

### Memory Adapter

1. [ ] Store `defaults` from `SearchAdapterConfig` in constructor
2. [ ] In `search()` / `searchAll()`: resolve `prefix`, `fuzzy`, `fieldBoosts` using resolution order
3. [ ] When `prefix` is resolved to `true`: stop filtering out `isPrefix`-flagged tokens in `buildQueryTokens`
4. [ ] Set `capabilities.prefix = true`
5. [ ] Write tests TV-MEM-001, TV-MEM-002, TV-MEM-003

### IndexedDB Adapter

6. [ ] Add `defaults?: SearchDefaults` to `IndexedDbAdapterOptions`
7. [ ] Store defaults in constructor
8. [ ] In `search()` / `searchAll()`: resolve options using resolution order
9. [ ] When `prefix` is resolved to `true`: stop filtering out `isPrefix`-flagged tokens
10. [ ] Set `capabilities.prefix = true`
11. [ ] Write tests TV-IDB-001, TV-IDB-002

### Postgres Adapter

12. [ ] Add `defaults?: SearchDefaults` to `PostgresAdapterOptions`
13. [ ] Store defaults in constructor
14. [ ] In `search()` / `searchAll()`: resolve options using resolution order
15. [ ] When `prefix` is resolved to `true` (independent of fuzzy): use `:*` prefix operator on lexemes
16. [ ] Ensure `prefix: true` + `fuzzy: true` does not duplicate `:*`
17. [ ] Set `capabilities.prefix = true`
18. [ ] Write tests TV-PG-001, TV-PG-002, TV-PG-003

### Meilisearch Adapter

19. [ ] Add `defaults?: SearchDefaults` to `MeilisearchAdapterOptions`
20. [ ] Store defaults in constructor
21. [ ] In `search()` / `searchAll()`: resolve `fuzzy` using resolution order (prefix is no-op for Meilisearch)
22. [ ] Set `capabilities.prefix = true`
23. [ ] Write tests TV-MS-001, TV-MS-002

## Verification Steps

```bash
cd searchfn/adapter-memory && npm test
cd searchfn/adapter-indexeddb && npm test
cd searchfn/adapter-postgres && npm test
cd searchfn/adapter-meilisearch && npm test
# Expected: all tests pass (existing + new)

cd searchfn/adapter-memory && npm run typecheck
cd searchfn/adapter-indexeddb && npm run typecheck
cd searchfn/adapter-postgres && npm run typecheck
cd searchfn/adapter-meilisearch && npm run typecheck
# Expected: no type errors
```

## Stop Condition

All adapter tests pass. Each adapter correctly resolves defaults and supports prefix matching (or advertises it as a no-op for Meilisearch). All capabilities objects are accurate.
