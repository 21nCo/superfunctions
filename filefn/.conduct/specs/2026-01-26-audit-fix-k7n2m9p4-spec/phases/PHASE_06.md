# PHASE_06

## Phase goal
Align shared persistence + rate limiting APIs with the audited spec and update FileFn to use them with ISO8601 resetAt.

## In scope
- `@superfunctions/db` `KVStoreAdapter` exported type shape.
- `@superfunctions/middleware` rate limiter creation + decision shape.
- FileFn server integration via `config.rateLimit`.

## Out of scope
- Proxy uploads/downloads.
- Authz enforcement (already done in Phase 03).

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/packages/db/src/adapter/types.ts` (export `KVStoreAdapter` per spec)
  - `/Users/ar/dev/superfunctions/packages/middleware/src/rate-limit.ts` (export `createRateLimiter` + `RateLimiter.check` per spec)
  - `/Users/ar/dev/superfunctions/filefn/server/src/index.ts` (accept `rateLimit` config object)
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/routes.ts` (update rate limit integration call signature)
  - `/Users/ar/dev/superfunctions/filefn/server/src/errors.ts` (rateLimited details use ISO8601)
- Tests:
  - Add or update `packages/middleware` tests for TV-RATE-001/TV-RATE-NEG-001.
  - Add a type-level test for KVStoreAdapter shape (TV-KVSTORE-001/NEG).

## Requirements covered
- PKG-007
- PKG-006
- RATE-001

## Implementation tasks
1. Update `KVStoreAdapter` export to:
   - `set({ key, value, ttlSeconds? })`
   - optional `incr({ key, by?, ttlSeconds? })`
2. Update `createRateLimiter` to accept `persistence: Adapter | KVStoreAdapter` and expose `check({ key, windowSeconds, limit })`.
3. Update FileFn config to accept `rateLimit: { persistence, algorithm?, limits }` and internally construct a `RateLimiter`.
4. Update FileFn rate limit keys to include route category and principal/tenant when available.
5. Ensure rate-limited errors return `FILEFN_RATE_LIMITED` with `details.resetAt` ISO8601.

## Verification steps
1. Run package tests:
   - `npm test -- --filter=@superfunctions/db --filter=@superfunctions/middleware --filter=@filefn/server`
2. Confirm vectors pass:
   - TV-KVSTORE-001 / TV-KVSTORE-NEG-001
   - TV-RATE-001 / TV-RATE-NEG-001

## Stop condition
Report:
- the final exported TypeScript signatures for KVStoreAdapter and RateLimiter,
- confirmation that FileFn emits ISO resetAt values.
