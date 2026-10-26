# PHASE_10: Optional HTTP API

## Phase goal

Expose optional HTTP server with routes for controls (POST, GET, PATCH, DELETE), frameworks (same), evidence (POST, GET list, GET by id), checks (POST, GET, POST run, DELETE), readiness (GET control, GET framework), export (POST auditor-pack). All responses JSON envelope. Document routes and method contract.

## In scope

- POST /controls, GET /controls, GET /controls/:id, PATCH /controls/:id, DELETE /controls/:id
- POST /frameworks, GET /frameworks, GET /frameworks/:id, PATCH /frameworks/:id, DELETE /frameworks/:id
- POST /evidence, GET /evidence (query: controlId, frameworkId, type, since), GET /evidence/:id
- POST /checks, GET /checks, GET /checks/:id, POST /checks/:id/run, DELETE /checks/:id
- GET /readiness/control/:controlId, GET /readiness/framework/:frameworkId
- POST /export/auditor-pack (body: { frameworkId?, since? })
- Response shape: { ok: true, result } or { ok: false, error: { code, message, details } }; HTTP status 2xx success, 4xx/5xx failure

## Out of scope

- Auth middleware (deployment-defined); dashboard UI; OpenAPI spec (optional)

## Deliverables

- `src/server/router.ts` or `src/http/routes.ts` – route definitions calling CompFnAPI
- Mount on Express/Hono/Fastify or equivalent; config to enable/disable server
- Integration test or manual: TV-HTTP-001 – POST control, GET control, GET nonexistent → 4xx + envelope
- README: “HTTP API” section with routes and request/response envelope

## Requirements covered

- HTTP-001

## Implementation tasks

1. Create HTTP router that receives CompFnAPI instance. Map POST /controls to controls.create(body), GET /controls to controls.list(query), GET /controls/:id to controls.get(id), PATCH /controls/:id to controls.update(id, body), DELETE /controls/:id to controls.delete(id). Same for frameworks. For evidence: POST /evidence → evidence.create(body); GET /evidence → evidence.list(query); GET /evidence/:id → evidence.get(id). For checks: POST /checks, GET /checks, GET /checks/:id, POST /checks/:id/run, DELETE /checks/:id. For readiness: GET /readiness/control/:controlId, GET /readiness/framework/:frameworkId. For export: POST /export/auditor-pack with body { frameworkId?, since? }.
2. Serialize envelope: success → status 200 (or 201 for create), body { ok: true, result }. failure → status 400/404/413/500 as appropriate, body { ok: false, error: { code, message, details } }.
3. Add test: create control via POST; GET by id; GET nonexistent id → 404 and envelope with code CONTROL_NOT_FOUND.
4. Document routes and envelope in README.

## Verification steps

- Start server; run TV-HTTP-001 (POST, GET, GET nonexistent); verify envelope and status codes.
- All existing unit tests still pass.

## Stop condition

- HTTP API implemented and documented; TV-HTTP-001 passes.
