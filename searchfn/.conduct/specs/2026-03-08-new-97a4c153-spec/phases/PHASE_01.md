# PHASE_01

## Phase goal
Replace `@searchfn/server` with a thin adapter-driven HTTP layer using `@superfunctions/http`.

## In scope / Out of scope
In scope:
- New server constructor and route handlers.
- Canonical envelopes, validation, limits, auth callback wiring, lifecycle close.

Out of scope:
- External adapter logic internals.
- Docs content.

## Deliverables
- `searchfn/server/src/server.ts` (rewritten)
- `searchfn/server/src/routes/status.ts` (new)
- `searchfn/server/src/routes/index.ts` (new)
- `searchfn/server/src/routes/search.ts` (new)
- `searchfn/server/src/routes/search-all.ts` (new)
- `searchfn/server/src/routes/remove.ts` (new)
- `searchfn/server/src/routes/clear.ts` (new)
- `searchfn/server/src/http/errors.ts` (new)
- `searchfn/server/src/http/validation.ts` (new)
- `searchfn/server/src/index.ts` (updated exports)
- `searchfn/server/__tests__/server-routes.test.ts` (new)

## Requirements covered
- API-002
- SRV-001
- SRV-002
- SRV-003
- SRV-004

## Implementation tasks
1. Implement `createSearchFnServer` that accepts `adapter`, `basePath`, `limits`, `authorize`, and `logger`.
2. Implement six route handlers delegating to adapter methods only.
3. Implement canonical validation and envelope/error mapping.
4. Add auth callback enforcement and redacted structured logging hooks.
5. Implement `close()` with optional `adapter.dispose()` invocation.
6. Add route tests covering success paths and canonical error paths.

## Verification steps
1. `npm --prefix searchfn/server run build`
- Expected: build succeeds.
2. `npm --prefix searchfn/server test -- --runInBand`
- Expected: all server route tests pass.
3. `npm --prefix searchfn/server run typecheck`
- Expected: exit code 0.

## Stop condition
Server package exposes only thin adapter transport behavior and passes route/validation/auth/lifecycle tests.
