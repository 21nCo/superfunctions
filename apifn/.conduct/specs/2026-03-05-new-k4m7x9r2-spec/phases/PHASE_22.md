# Phase 22: authfn + secfn + logfn Integration

## Phase Goal
Implement integrations with authfn (test tokens), secfn (rate limits), and logfn (structured logging).

## In Scope
- `mintTestToken()` — create short-lived API keys via authfn
- Token injection in collection runs
- `fetchRateLimits()` — query secfn for rate limit headroom
- Rate limit display in explorer
- `logfnReporter()` — RunReporter that logs to logfn
- Structured logging throughout CLI

## Out of Scope
- authfn/secfn/logfn core implementation

## Deliverables
- `apifn/core/src/integrations/authfn.ts`
- `apifn/core/src/integrations/secfn.ts`
- `apifn/core/src/integrations/logfn.ts`
- `apifn/core/__tests__/integrations.test.ts`

## Requirements Covered
- AUTH-001, AUTH-002, AUTH-003, SEC-001, SEC-002, LOG-001, LOG-002

## Implementation Tasks
1. [ ] Implement `mintTestToken(authfn, options)`: call `authfn.createKey()` with TTL, scopes, resourceIds
2. [ ] Implement TTL validation: reject > 3600s
3. [ ] Implement token injection: middleware that adds Authorization header to collection requests
4. [ ] Implement `fetchRateLimits(rateLimiter, endpoints, context)`: call `rateLimiter.check()` or storage read for each endpoint
5. [ ] Implement rate limit data rendering in explorer UI
6. [ ] Implement `logfnReporter()`: map RunReporter callbacks to logfn events
7. [ ] Implement CLI logging integration: use logfn when available, console fallback
8. [ ] Write tests with mocked authfn/secfn/logfn instances
9. [ ] Export from core index

## Verification Steps
1. `npm run test` → all integration tests pass
2. TV-AUTH-001: Token minted with correct TTL and scopes
3. NEG-TV-AUTH-001: TTL > 3600 → error
4. TV-SEC-001: Rate limits fetched for endpoints
5. TV-LOG-001: logfn reporter logs correct events

## Stop Condition
All three integrations work with mocked dependencies. Report test results.
