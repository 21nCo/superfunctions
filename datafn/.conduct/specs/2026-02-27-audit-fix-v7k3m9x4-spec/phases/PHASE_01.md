# PHASE 01: Security CRITICAL — Server Fixes

## Phase goal
Fix all 8 CRITICAL security issues: WS auth, authz bypass, type validation enforcement, batch limits, byte-based payload, prototype pollution blocking.

## In scope
- SEC-C1/C2: WebSocket auth via HTTP upgrade + server-derived namespace
- SEC-C3: Extend `validateQueryAuthz` to cover aggregations, groupBy, having, sort, search.fields
- SEC-C4: Add per-step authz to `/transact` endpoint
- SEC-C5: Wire field value type validation into mutation validation
- SEC-C6: Add batch size limit enforcement to push and mutation endpoints
- SEC-C7: Fix `readBodyWithLimit` to use `Buffer.byteLength` + default 5MB limit
- SEC-C8: Wire prototype pollution check into validation entry points

## Out of scope
- WS heartbeat/limits (Phase 06)
- HIGH security issues (Phase 05)
- Logger integration (Phase 13)

## Deliverables
- `datafn/server/src/ws.ts` — Add auth parameter to `addClient()`, ignore client namespace, derive from auth
- `datafn/server/src/validation/authz.ts` — Extend `validateQueryAuthz` for all query fields
- `datafn/server/src/routes/transact.ts` — Add authz validation per step
- `datafn/server/src/validation/mutation.ts` — Add type validation using `validateFieldValue`, batch size check, prototype check
- `datafn/server/src/validation/query.ts` — Add prototype check to filter validation
- `datafn/server/src/http/middleware.ts` — Fix byte length, set default maxPayloadBytes
- `datafn/server/src/routes/sync.ts` — Add batch size check in push handler
- `datafn/server/src/server.ts` — Wire WS auth into websocketHandler, set config defaults

## Requirements covered
SEC-001, SEC-002, SEC-003, SEC-004, SEC-005, SEC-006, SEC-007, SEC-008

## Implementation tasks
1. **WS auth** (`ws.ts`):
   - Change `addClient(client)` signature to `addClient(client, authContext: { namespace: string })`
   - Store namespace from `authContext`, not from `hello` message
   - In `handleMessage`, ignore `msg.namespace` field
   - In `server.ts`, wire `authContextProvider.getContext()` into the WS upgrade path
   - Reject unauthenticated WS connections with close code `4401`

2. **Authz coverage** (`authz.ts`):
   - In `validateQueryAuthz`:
     - Extract fields from `query.aggregations[*].field`
     - Extract fields from `query.groupBy[]`
     - Extract fields from `query.having` (recursive filter field extraction)
     - Extract fields from `query.sort[]` (strip `-` prefix)
     - Extract fields from `query.search.fields[]`
     - Check each against `policy.read.fields`

3. **Transact authz** (`routes/transact.ts`):
   - Import `validateMutationAuthz` and `validateQueryAuthz`
   - Before calling `executeTransaction`, validate each step:
     - Mutation steps: `validateMutationAuthz(step, policy)`
     - Query steps: `validateQueryAuthz(step, policy)`
   - On any authz failure: return 403 without executing any steps

4. **Type validation** (`validation/mutation.ts`):
   - Import `validateFieldValue` from `@datafn/core`
   - In mutation validation, after key validation, validate each field value against schema type
   - Import `checkPrototypePollution` from `@datafn/core`
   - Run prototype check on `record` object before any other validation

5. **Batch limit** (`routes/sync.ts` + `routes/mutation.ts`):
   - In push handler, check `mutations.length > limits.maxBatchSize` (default 500)
   - Return `DFQL_INVALID` with count details

6. **Byte measurement** (`http/middleware.ts`):
   - Replace `body.length` with `Buffer.byteLength(body, 'utf8')`
   - Set default `maxPayloadBytes: 5_242_880` in server config

7. **Prototype check in queries** (`validation/query.ts`):
   - Run `checkPrototypePollution` on filter objects

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- Write and run security-focused tests (can be in existing test files or new `__tests__/security.test.ts`):
  - WS connection rejected without auth
  - WS namespace spoofing ignored
  - Aggregation authz bypass blocked
  - GroupBy authz bypass blocked
  - Sort/having/search authz bypass blocked
  - Transact authz enforced
  - Type validation rejects wrong types
  - Batch limit enforced
  - Multi-byte payload correctly measured
  - Prototype pollution rejected

## Stop condition
All 8 CRITICAL security vectors pass. Existing tests still pass. Report results and any deviations.
