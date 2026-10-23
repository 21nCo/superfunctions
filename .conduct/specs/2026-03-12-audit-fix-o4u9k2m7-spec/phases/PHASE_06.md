# PHASE 06

## Phase goal
Migrate PlugFn OAuth orchestration to `@superfunctions/oauth-flow`.

## In scope / Out of scope

- **In scope:** plugfn connection manager OAuth path migration.
- **Out of scope:** authfn and recfn migrations.

## Deliverables

- `plugfn/typescript/src/core/connection-manager.ts` delegation to oauth-flow service.
- Updated oauth dependency wiring in `plugfn/typescript/src/core/plug-fn.ts`.
- Updated PlugFn OAuth tests.

## Requirements covered

- OAUTH-009
- PLAT-003

## Implementation tasks

1. Replace duplicated start/callback/refresh/revoke orchestration helpers with oauth-flow delegation.
2. Keep provider descriptor mapping and plugfn-specific connection persistence behavior.
3. Add deterministic connection tie-breaker behavior if not already migrated.
4. Update tests for callback replay, redirect mismatch, refresh failure, and tie-breaker determinism.

## Verification steps

1. Run:
```bash
npm -w plugfn run test -- connection-manager.test.ts oauth-integration.test.ts
```
Expected: all OAuth integration tests pass.

2. Run:
```bash
rg -n "createOAuthFlowService" plugfn/typescript/src/core/connection-manager.ts plugfn/typescript/src/core/plug-fn.ts
```
Expected: oauth-flow usage is present.

## Stop condition
PlugFn OAuth behavior is fully delegated to shared oauth-flow and tests pass.
