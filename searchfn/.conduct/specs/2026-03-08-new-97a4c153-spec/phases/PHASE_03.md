# PHASE_03

## Phase goal
Deliver full Postgres adapter implementation with conformance and integration coverage.

## In scope / Out of scope
In scope:
- Postgres adapter implementation for all required operations.
- SQL schema/index management for adapter-owned tables.
- Postgres integration tests.

Out of scope:
- Elasticsearch/OpenSearch and Meilisearch adapters.
- Docs publication.

## Deliverables
- `searchfn/adapters/src/postgres.ts` (rewritten from stub)
- `searchfn/adapters/src/postgres-schema.ts` (new)
- `searchfn/adapters/src/postgres-sql.ts` (new)
- `searchfn/adapters/__tests__/postgres.test.ts` (new)
- `searchfn/adapters/__tests__/conformance/postgres.conformance.test.ts` (new)
- `searchfn/adapters/docker-compose.postgres.yml` (new)

## Requirements covered
- ADP-PG-001
- ADP-CONF-001
- PRD-001

## Implementation tasks
1. Implement initialize/index/search/searchAll/remove/clear with deterministic ordering.
2. Add adapter schema bootstrap and idempotent initialization path.
3. Add timeout + retry classification for transient DB errors.
4. Add conformance harness binding for Postgres adapter.
5. Add docker-backed integration tests.

## Verification steps
1. `docker compose -f searchfn/adapters/docker-compose.postgres.yml up -d`
- Expected: postgres container healthy.
2. `npm --prefix searchfn/adapters test -- __tests__/postgres.test.ts __tests__/conformance/postgres.conformance.test.ts --runInBand`
- Expected: all tests pass.
3. `docker compose -f searchfn/adapters/docker-compose.postgres.yml down -v`
- Expected: clean teardown.

## Stop condition
Postgres adapter is fully operational, deterministic, and passes conformance + integration tests.
