# PHASE_01 — Elasticsearch & OpenSearch Prefix Support

## Phase Goal

Implement prefix matching and construct-time defaults in the Elasticsearch and OpenSearch adapters.

## In Scope

- Elasticsearch adapter: `defaults` option, prefix query construction, option resolution
- OpenSearch adapter: `defaults` option passthrough
- Unit tests for query body construction
- Capabilities update

## Out of Scope

- Other adapters (Memory, IndexedDB, Postgres, Meilisearch)
- Client/server/datafn-provider changes

## Deliverables

- `searchfn/adapter-elasticsearch/src/elasticsearch.ts` — modified
- `searchfn/adapter-elasticsearch/__tests__/elasticsearch.test.ts` — modified (new tests)
- `searchfn/adapter-opensearch/src/opensearch.ts` — modified
- `searchfn/adapter-opensearch/__tests__/opensearch.test.ts` — modified (if exists, new tests)

## Requirements Covered

ADP-001, ADP-002, ADP-003, ADP-004

## Implementation Tasks

1. [ ] Add `defaults?: SearchDefaults` to `ElasticsearchAdapterOptions`
2. [ ] Store defaults in the adapter constructor
3. [ ] Create a private `resolveOptions(params)` method that applies resolution order for `fuzzy`, `prefix`, `fieldBoosts`
4. [ ] Refactor `search()` to use `resolveOptions` and build query dynamically:
   - No prefix, no fuzzy → single `multi_match` (current behavior)
   - Prefix only → `bool.should` with `multi_match` + `phrase_prefix`, `minimum_should_match: 1`
   - Fuzzy only → single `multi_match` with `fuzziness` (current behavior)
   - Both → `bool.should` with three clauses, `minimum_should_match: 1`
5. [ ] Refactor `searchAll()` with the same query construction logic (extract shared helper)
6. [ ] Set `capabilities.prefix = true`
7. [ ] Update `OpenSearchAdapterOptions` to include `defaults?: SearchDefaults`
8. [ ] Write tests:
   - TV-ES-001: prefix true matches partial terms
   - TV-ES-002: prefix query structure verification
   - TV-ES-003: prefix false/omitted uses original query
   - TV-ES-004: prefix + fuzzy combined
   - TV-ES-005: construct-time defaults applied
   - TV-ES-006: query-time overrides construct-time default
9. [ ] Run existing tests to verify no regressions

## Verification Steps

```bash
cd searchfn/adapter-elasticsearch && npm test
# Expected: all tests pass (existing + new)

cd searchfn/adapter-opensearch && npm test
# Expected: all tests pass

cd searchfn/adapter-elasticsearch && npm run typecheck
cd searchfn/adapter-opensearch && npm run typecheck
# Expected: no type errors
```

## Stop Condition

All Elasticsearch/OpenSearch tests pass. Prefix matching works with the bool.should query pattern. Construct-time defaults are resolved correctly.
