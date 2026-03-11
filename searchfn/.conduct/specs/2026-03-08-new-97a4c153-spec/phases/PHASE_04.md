# PHASE_04

## Phase goal
Implement one elastic-compatible adapter covering both Elasticsearch and OpenSearch.

## In scope / Out of scope
In scope:
- Unified adapter implementation with dialect config.
- Request/response translation and deterministic sorting normalization.
- Integration tests for both backends.

Out of scope:
- Meilisearch implementation.
- Docs publication.

## Deliverables
- `searchfn/adapters/src/elasticsearch.ts` (rewritten)
- `searchfn/adapters/src/opensearch.ts` (new alias/wrapper or dialect export)
- `searchfn/adapters/src/elastic-client.ts` (new)
- `searchfn/adapters/__tests__/elasticsearch.test.ts` (new)
- `searchfn/adapters/__tests__/opensearch.test.ts` (new)
- `searchfn/adapters/__tests__/conformance/elastic.conformance.test.ts` (new)
- `searchfn/adapters/docker-compose.elastic.yml` (new)

## Requirements covered
- ADP-ES-001
- ADP-CONF-001
- PRD-001

## Implementation tasks
1. Replace stub with real adapter operations (index, search, searchAll, remove, clear).
2. Add dialect abstraction for Elasticsearch/OpenSearch compatibility differences.
3. Normalize backend result ordering using canonical tie-break rules.
4. Add timeout/retry/error classification.
5. Add conformance and docker integration tests for both dialects.

## Verification steps
1. `docker compose -f searchfn/adapters/docker-compose.elastic.yml up -d`
- Expected: elastic + opensearch containers healthy.
2. `npm --prefix searchfn/adapters test -- __tests__/elasticsearch.test.ts __tests__/opensearch.test.ts __tests__/conformance/elastic.conformance.test.ts --runInBand`
- Expected: all tests pass.
3. `docker compose -f searchfn/adapters/docker-compose.elastic.yml down -v`
- Expected: clean teardown.

## Stop condition
Elastic-compatible adapter supports both engines and passes deterministic integration tests.
