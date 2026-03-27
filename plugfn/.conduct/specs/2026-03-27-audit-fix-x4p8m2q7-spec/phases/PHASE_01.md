# Phase goal

Bind PlugFn runtime persistence cleanly to `@superfunctions/db` and add first-class OAuth storage modules.

# In scope / Out of scope

- In scope: TypeScript config contract, explicit OAuth state/token storage modules, DB model mappings, storage tests
- Out of scope: legacy OAuth shim thinning, router auth/raw-body hardening

# Deliverables

- `plugfn/typescript/src/types/config.ts`
- `plugfn/typescript/src/storage/connection-storage.ts`
- `plugfn/typescript/src/storage/oauth-state-store.ts`
- `plugfn/typescript/src/storage/oauth-token-vault.ts`
- `plugfn/typescript/src/storage/adapters/database.ts`
- `plugfn/typescript/src/core/connection-manager.ts`
- `plugfn/typescript/tests/oauth-storage-contract.test.ts`
- `plugfn/docs/architecture.md`

# Requirements covered

- `PLAT-001`
- `OAUTH-001`

# Implementation tasks

1. Replace ad hoc or partial DB typing with canonical `@superfunctions/db` adapter typing in PlugFn config.
2. Add explicit first-class storage modules for OAuth state and token persistence.
3. Define model/table names for connections, OAuth states, OAuth tokens, workflows, and executions.
4. Update `ConnectionManager` to depend on those stores rather than synthetic connection records.
5. Add targeted tests that prove callback persistence writes token/state records through first-class stores.

# Verification steps

- Run `npx tsc -p plugfn/typescript/tsconfig.json --noEmit`
- Run `npm test --workspace plugfn -- --run plugfn/typescript/tests/oauth-storage-contract.test.ts`
- Run `rg -n "__oauth_state_system__|__oauth_token_system__" plugfn/typescript/src`
- Expected outcome: typecheck passes, targeted storage tests pass, and synthetic OAuth storage markers are absent from runtime code.

# Stop condition

Report the final storage model names and the files that now own OAuth state/token persistence.
