# PHASE_12: Authz, limits, logging, status (cross-cutting hardening)

## Phase goal

Implement the authorization hook, enforce limits consistently across endpoints, ensure observability constraints, and expose the status endpoint with capabilities and limits.

## In scope

- Authorization hook wiring across all HTTP endpoints and realtime subscribe actions.
- Limit enforcement:
  - `maxPayloadBytes`
  - `maxPatchOps`
  - `maxQueryLimit`
  - `maxExpandDepth`
  - `maxFilterDepth`
- Structured logging for critical operations without leaking raw document bodies or asset bytes.
- Status endpoint:
  - `GET /contentfn/status`
  - includes server time, capabilities, effective limits

## Out of scope

- Advanced RBAC UI (belongs to `cmsfn`)

## Deliverables

- `contentfn/server/src/auth/authorize.ts`
- `contentfn/server/src/limits/limits.ts`
- `contentfn/server/src/logging/logger.ts`
- `contentfn/server/src/http/endpoints/status.ts`
- Tests implementing:
  - TV-AUTH-ALLOW-001
  - TV-AUTH-DENY-001
  - TV-LIMIT-PAYLOAD-001
  - TV-LIMIT-PATCHOPS-001
  - TV-OBS-LOGGING-001
  - TV-OBS-LOGGING-002
  - TV-STATUS-001
  - TV-STATUS-002

## Requirements covered

- AUTH-001
- LIMIT-001
- OBS-001
- STATUS-001

## Implementation tasks

1. Define action strings and map each endpoint to a stable action name (e.g. `datasets.create`, `schema.upsert`, `docs.get`, `docs.patch`, `assets.upload`, `webhooks.register`, `realtime.subscribe`).
2. Implement `authorize(ctx, action, input)` hook:
   - default allow when no hook configured
   - return `PERMISSION_DENIED` when denied
3. Enforce limits:
   - reject oversized JSON with `PAYLOAD_TOO_LARGE`
   - reject patch ops length > max with deterministic error code
   - clamp or reject query limit > max deterministically (must match SPEC/TVs)
   - reject expand depth > max with `QUERY_TOO_COMPLEX`
4. Implement logging:
   - log action, dataset, IDs, actor subject (if present)
   - exclude raw bodies/bytes by default
5. Implement status endpoint:
   - declared capabilities based on configured features (realtime enabled etc.)
6. Add tests asserting:
   - denial returns correct code and does not leak content
   - limit errors return correct codes
   - logs do not include secrets/bytes

## Verification steps

- Run auth/limits/status/logging tests.
- Manual smoke: enable deny-all authorize hook and ensure all endpoints consistently return `PERMISSION_DENIED`.

## Stop condition

- Cross-cutting security and observability requirements are satisfied and tests pass.

