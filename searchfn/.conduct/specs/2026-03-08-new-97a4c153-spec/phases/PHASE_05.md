# PHASE_05

## Phase goal
Implement Meilisearch adapter fully with deterministic and resilient behavior.

## In scope / Out of scope
In scope:
- Meilisearch adapter methods and index lifecycle.
- Retry/timeout/auth error mapping.
- Conformance and integration tests.

Out of scope:
- Docs publication.
- Internal consumer migration.

## Deliverables
- `searchfn/adapters/src/meilisearch.ts` (rewritten)
- `searchfn/adapters/src/meili-client.ts` (new)
- `searchfn/adapters/__tests__/meilisearch.test.ts` (new)
- `searchfn/adapters/__tests__/conformance/meilisearch.conformance.test.ts` (new)
- `searchfn/adapters/docker-compose.meili.yml` (new)

## Requirements covered
- ADP-MEI-001
- ADP-CONF-001
- PRD-001

## Implementation tasks
1. Implement full adapter behavior against Meilisearch indexes.
2. Implement deterministic sorting normalization for ties.
3. Add timeout/retry policies with retryable error classification.
4. Add conformance and docker integration tests.

## Verification steps
1. `docker compose -f searchfn/adapters/docker-compose.meili.yml up -d`
- Expected: meilisearch container healthy.
2. `npm --prefix searchfn/adapters test -- __tests__/meilisearch.test.ts __tests__/conformance/meilisearch.conformance.test.ts --runInBand`
- Expected: all tests pass.
3. `docker compose -f searchfn/adapters/docker-compose.meili.yml down -v`
- Expected: clean teardown.

## Stop condition
Meilisearch adapter is fully implemented and passes conformance + integration tests.
