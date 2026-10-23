# PHASE 05

## Phase goal
Add oauth-storage bridge for `@superfunctions/db` persistence and explicit OAuth storage models.

## In scope / Out of scope

- **In scope:** oauth-storage adapter implementation for db Adapter, schema/model mapping, tests.
- **Out of scope:** plugfn/authfn integration.

## Deliverables

- New adapter module under `packages/oauth-storage/src/adapters/` for db Adapter.
- Schema/model mapping docs in oauth-storage.
- Contract tests for state/token lifecycle using db adapter.

## Requirements covered

- OAUTH-008
- OAUTH-013

## Implementation tasks

1. Implement db-backed OAuthStateStore and TokenVault wrappers.
2. Define required model names and optional override mapping.
3. Add validation for missing schema mappings.
4. Add tests for put/get/consume/deleteExpired and token operations.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/oauth-storage run test
npm -w @superfunctions/oauth-storage run typecheck
```
Expected: new adapter tests pass.

2. Run:
```bash
rg -n "oauth_states|oauth_token_vault" packages/oauth-storage/src packages/oauth-storage/src/__tests__
```
Expected: explicit model names or mappings are present.

## Stop condition
oauth-storage supports `@superfunctions/db` persistence with passing contract tests.
