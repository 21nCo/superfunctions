# Phase 19: Limits, rate limiting, and security hardening

## Phase goal
Enforce all configurable limits, add rate limiting, and harden security (PII redaction, secret leakage prevention, input validation).

## In scope
- Enforce limits: max concurrent bots (100), max recording duration (8h), max transcript segments (100,000), max WebSocket connections per bot (50), max webhooks per namespace (20), max calendars per namespace (10), pagination max (100).
- Rate limiting: 100 req/s per namespace (configurable).
- PII redaction (redact=true on export — wire from Phase 07 if not already).
- Security audit: verify no secrets in logs, no secrets in API responses, no secrets in webhook payloads.
- Input validation hardening: meeting URL patterns, config value ranges, search query length.

## Out of scope
- New features. New adapters.

## Deliverables
- `recfn/server/src/middleware/rate-limit.ts` — rate limiting middleware
- `recfn/server/src/middleware/limits.ts` — limit enforcement middleware
- `recfn/server/src/config.ts` — server configuration with limit defaults
- `recfn/server/__tests__/limits.test.ts`
- `recfn/server/__tests__/rate-limit.test.ts`
- `recfn/server/__tests__/security-audit.test.ts`

## Requirements covered
- LIMIT-001, LIMIT-002, LIMIT-003, SEC-001, SEC-002, SEC-003, SEC-004, SEC-005, SEC-006, TRX-008, EXP-002

## Implementation tasks
1. Create server config module: define all limit defaults (max bots, max duration, etc.), load from env vars or config file.
2. Implement limit enforcement: check concurrent bot count before creating, check webhook count before creating, check calendar count, etc.
3. Implement rate limiting middleware: per-namespace request counter with sliding window. Return 429 Too Many Requests on exceed.
4. Update pagination: enforce limit ≤ 100, return BAD_REQUEST for limit > 100.
5. Security audit tests: create bot lifecycle, grep all log output for API key values, OAuth tokens, participant emails — assert none found.
6. Verify webhook payloads don't contain secrets.
7. Verify API responses don't leak internal fields (e.g., storageRef without downloadUrl signing).
8. Input validation: tighten meeting URL regex, validate config ranges (joinTimeout 1000–60000), search query max 500 chars.
9. Write tests: limit exceeded returns error, rate limit returns 429, security assertions pass.

## Verification steps
- `cd recfn/server && npx vitest run` — all limit, rate-limit, and security tests pass.
- Tests cover: TV-LIMIT-001, TV-LIMIT-002, TV-LIMIT-003, TV-SEC-001–004.

## Stop condition
- All limits enforced. Rate limiting works. Security audit tests pass (no secret leakage). All tests pass. Report: "Phase 19 complete; limits and security ready for Phase 20."
