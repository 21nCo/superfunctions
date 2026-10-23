# PHASE_01: Status + ContentFn health/capability checks

## Phase goal

Implement `/cmsfn/status` and ContentFn availability/capability checks with deterministic failure behavior.

## In scope

- Endpoint: `GET /cmsfn/status`
- ContentFn status fetch:
  - verify required capabilities exist (schema/docs/assets; realtime when preview enabled)
  - return `CONTENTFN_UNAVAILABLE` when unreachable/missing capabilities

## Out of scope

- Roles
- Studio UI beyond a status page

## Deliverables

- `cmsfn/server/src/index.ts` (createCmsfnServer)
- `cmsfn/server/src/http/status.ts`
- `cmsfn/server/src/contentfn/statusClient.ts`
- Tests for:
  - TV-STATUS-001
  - TV-STATUS-002
  - TV-STATUS-CONTENTFN-DOWN-001
  - TV-ENV-OK-001

## Requirements covered

- STATUS-001
- ENV-001 (server envelope)

## Implementation tasks

1. Implement server skeleton with router and envelope responses.
2. Implement ContentFn status client:
   - call `/contentfn/status`
   - parse capabilities deterministically
3. Implement CmsFn status response:
   - serverTime
   - capabilities (cmsfn)
   - datasets list in config order
4. Add tests that simulate:
   - ContentFn up
   - ContentFn down
   - unauthorized status

## Verification steps

- Run status tests.

## Stop condition

- Status endpoint is correct and ContentFn failure modes are explicit and deterministic.

