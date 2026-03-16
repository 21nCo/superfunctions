# Phase goal

Migrate `plugfn` OAuth/connection internals to shared OAuth packages.

## In scope / Out of scope

- **In scope**:
  - Replace `plugfn` local OAuth flow implementation.
  - Rewire connection manager to shared state/token services.
  - Remove reflection/internal access hacks for token store usage.
- **Out of scope**:
  - Route authentication hardening.
  - Email adapter implementations.

## Deliverables

- `plugfn/typescript/src/core/connection-manager.ts`
- `plugfn/typescript/src/core/plug-fn.ts`
- `plugfn/typescript/src/auth/*` (removed or converted to wrappers)
- `plugfn/typescript/src/types/connection.ts`
- `plugfn/typescript/tests/connection-manager.test.ts`
- `plugfn/typescript/tests/oauth-integration.test.ts`

## Requirements covered

- ARCH-002
- OAUTH-001
- OAUTH-002
- OAUTH-003
- OAUTH-005

## Implementation tasks

1. Inject shared OAuth service into connection manager constructor.
2. Replace in-memory state storage with durable `OAuthStateStore` adapter.
3. Remove direct property access patterns like `oauthHandler['tokenStore']`.
4. Ensure connection create/refresh/revoke use token vault record contracts.
5. Add regression tests for callback replay and refresh failure behavior.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm run type-check`
2. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run`
3. `rg -n "MemoryTokenStore|oauthHandler\['tokenStore'\]" /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src`
Expected outcome: tests pass and grep returns zero matches for removed internals.

## Stop condition

`plugfn` connection lifecycle fully uses shared OAuth services and passes OAuth regression tests.
