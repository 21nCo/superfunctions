# Phase 07: Runner registration and API auth

## Phase goal
Implement runner registration with token from secfn, API authentication (API key or bearer token from secfn), and webhook signature verification using secfn-stored secret.

## In scope
- POST /api/v1/runners/register: body { token, labels? }; validate token via secfn (e.g. compare with stored runner registration token); on success create runner record (runnerId, labels, tokenHash or no store of token); return { runnerId }; 401 RUNNER_TOKEN_INVALID on failure.
- Runner heartbeat or job poll: runner authenticates with runner-scoped secret (issued at register or derived from token); control plane returns next job or 204.
- API middleware: for /api/v1/* (except health), require Authorization header (Bearer <token> or X-API-Key); validate token via secfn; 401 if missing or invalid.
- Webhook verification: signing secret from secfn; verify HMAC of body with secret; reject request if invalid (401/403).

## Out of scope
- Multi-tenant authz (single-tenant: any valid API token can access all runs); dashboard UI.

## Deliverables
- `cifn/typescript/control-plane/src/api/auth.ts` (middleware: validate API token with secfn).
- `cifn/typescript/control-plane/src/runners/register.ts` (validate token, create runner, return runnerId).
- Runner: use token or runnerId+secret for heartbeat/job fetch; control plane validates runner auth for heartbeat.
- Webhook: read signing secret from secfn; verify in webhook handler.
- Tests: TV-RUNNER-002, TV-RUNNER-003, TV-SEC-001, TV-SEC-004.

## Requirements covered
- API-008, API-010, RUNNER-002, SEC-002, SEC-004, SEC-005.

## Implementation tasks
1. secfn: store API key(s) and runner registration token(s); control plane reads on startup or per request.
2. Auth middleware: extract Bearer or X-API-Key; call secfn or internal check; if invalid return 401; attach identity to request (optional).
3. POST /runners/register: read token from body; compare with secfn runner token (or hash); create runner record with runnerId (UUID); return { runnerId }; store no plaintext token.
4. Heartbeat/poll: runner sends runnerId and auth (e.g. header with runner secret); control plane verifies and returns next job for that runner or 204.
5. Webhook: read webhook secret from secfn (e.g. key "cifn.webhook.github"); compute HMAC of body; compare with X-Hub-Signature-256; reject if mismatch.
6. Tests: API without auth → 401; API with valid token → 200; register with invalid token → 401; register with valid token → 200 and runnerId; webhook with bad signature → 401/403.

## Verification steps
- curl GET /api/v1/runs without Authorization → 401.
- curl GET /api/v1/runs with valid Bearer token → 200. TV-SEC-001, TV-SEC-002 pass.
- POST /runners/register with invalid token → 401 RUNNER_TOKEN_INVALID; with valid token → 200 and runnerId. TV-RUNNER-002, TV-RUNNER-003 pass.
- POST /webhooks/github with invalid signature → 401 or 403; no run created. TV-SEC-004 pass.
- Run tests: `npm test` for auth and webhook.

## Stop condition
- API auth and runner registration and webhook verification implemented and tested. Report: "Phase 07 complete; auth ready for Phase 08 (CLI)."
