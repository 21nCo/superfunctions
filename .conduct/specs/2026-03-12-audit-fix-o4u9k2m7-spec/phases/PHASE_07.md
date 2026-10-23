# PHASE 07

## Phase goal
Migrate AuthFn social OAuth orchestration to `@superfunctions/oauth-flow` while preserving public behavior.

## In scope / Out of scope

- **In scope:** authfn social oauth internals and tests.
- **Out of scope:** comprehensive authfn feature expansion.

## Deliverables

- `authfn/ts-sdk/src/social-oauth/index.ts` internal delegation to oauth-flow.
- Compatibility-preserving social oauth API behavior.
- Updated authfn social OAuth tests.

## Requirements covered

- OAUTH-011
- OAUTH-007

## Implementation tasks

1. Integrate oauth-flow service in social oauth factory setup.
2. Preserve existing public method names and return shape unless explicitly documented with shim.
3. Keep revoke-failure recording semantics.
4. Update/extend tests to assert behavior parity.

## Verification steps

1. Run:
```bash
npm -w @authfn/core run test -- social-oauth.test.ts
npm -w @authfn/core run typecheck
```
Expected: tests and typecheck pass without behavior regressions.

2. Run:
```bash
rg -n "@superfunctions/oauth-flow" authfn/ts-sdk/src/social-oauth
```
Expected: shared oauth-flow is used.

## Stop condition
AuthFn social OAuth delegates to shared flow and maintains test-validated API compatibility.
