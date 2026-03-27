# Phase goal

Complete the TypeScript OAuth migration so PlugFn uses first-class shared OAuth persistence and the legacy auth path becomes wrapper-only.

# In scope / Out of scope

- In scope: TypeScript `ConnectionManager` OAuth migration, legacy shim reduction, migration docs/tests
- Out of scope: router/webhook auth hardening, Python parity

# Deliverables

- `plugfn/typescript/src/core/connection-manager.ts`
- `plugfn/typescript/src/auth/oauth-flow.ts`
- `plugfn/typescript/tests/connection-oauth.test.ts`
- `plugfn/typescript/tests/oauth-legacy-shim.test.ts`
- `plugfn/docs/migrations/oauth-shared-stack.md`

# Requirements covered

- `OAUTH-001`
- `OAUTH-002`

# Implementation tasks

1. Move any remaining token exchange, refresh, or callback orchestration logic out of `plugfn/typescript/src/auth/oauth-flow.ts`.
2. Keep the legacy module as a warning + delegation shim only.
3. Ensure callback completion persists token references and connection records without synthetic OAuth system records.
4. Publish a migration note describing legacy import replacement and removal target.
5. Add tests that fail if the legacy shim regains orchestration behavior.

# Verification steps

- Run `npm test --workspace plugfn -- --run plugfn/typescript/tests/connection-oauth.test.ts plugfn/typescript/tests/oauth-legacy-shim.test.ts`
- Run `rg -n "exchangeToken|refreshToken|MemoryOAuthStateStore|DefaultOAuthService" plugfn/typescript/src/auth/oauth-flow.ts`
- Expected outcome: targeted tests pass, and the legacy file contains only wrapper/deprecation logic rather than core orchestration logic.

# Stop condition

Report the exact shared-package replacement path and the remaining allowed behavior in the legacy module.
