# PHASE_14: Search / match operator behavior

## Phase goal

Finalize deterministic `match` query behavior (enabled vs disabled) and document integration with `searchfn` where applicable.

## In scope

- CFQL operator `match`:
  - enabled mode: returns deterministic hits
  - disabled mode: returns `QUERY_INVALID` deterministically
- Integration surface for building/refreshing search indexes (server-side hooks)

## Out of scope

- Advanced ranking UI (belongs to `cmsfn`)

## Deliverables

- `contentfn/server/src/search/match.ts`
- `contentfn/server/src/search/indexer.ts` (optional; can be minimal)
- Update CFQL validator and executor to route `match` appropriately.
- Tests implementing:
  - TV-QRY-MATCH-001
  - TV-QRY-MATCH-002

## Requirements covered

- SEARCH-001

## Implementation tasks

1. Define a server config flag indicating search enabled/disabled.
2. When disabled:
   - queries containing `match` fail with `QUERY_INVALID` and a clear message.
3. When enabled:
   - implement deterministic matching for at least string fields (title/name/etc.)
   - ensure ordering remains deterministic per QRY-002 (tie-breakers still apply)
4. Add tests for both enabled and disabled behavior.

## Verification steps

- Run match tests with search enabled and disabled configurations.

## Stop condition

- `match` operator behavior is deterministic and passes referenced TVs.

