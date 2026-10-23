# Phase goal

Implement OAuth transport and provider descriptor/policy registry.

## In scope / Out of scope

- **In scope**:
  - Token exchange and revoke HTTP client behavior.
  - Provider descriptor definitions for email and social providers.
  - Scope policy validation hooks.
- **Out of scope**:
  - `plugfn` runtime integration.
  - Email adapter execution logic.

## Deliverables

- `packages/oauth-http/src/token-client.ts`
- `packages/oauth-http/src/retry-policy.ts`
- `packages/oauth-http/src/errors.ts`
- `packages/oauth-providers/src/providers/google.ts`
- `packages/oauth-providers/src/providers/microsoft.ts`
- `packages/oauth-providers/src/providers/yahoo.ts`
- `packages/oauth-providers/src/providers/apple.ts`
- `packages/oauth-providers/src/providers/github.ts`
- `packages/oauth-providers/src/policy-registry.ts`
- `packages/oauth-http/tests/token-client.test.ts`
- `packages/oauth-providers/tests/policy-registry.test.ts`

## Requirements covered

- OAUTH-004
- OAUTH-006
- OAUTH-008
- MAIL-010

## Implementation tasks

1. Implement content-type aware token/revoke transport.
2. Normalize provider error responses into canonical error codes.
3. Define provider descriptors and default scope allowlists.
4. Implement provider policy registry read/validation logic.
5. Add tests for disallowed scopes and provider-policy block paths.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions && npm run test --workspace @superfunctions/oauth-http`
2. `cd /Users/serro/Documents/dev/n/superfunctions && npm run test --workspace @superfunctions/oauth-providers`
3. `cd /Users/serro/Documents/dev/n/superfunctions && npm run build --workspace @superfunctions/oauth-providers`
Expected outcome: transport and policy tests pass; canonical error mapping is deterministic.

## Stop condition

OAuth transport and provider registry packages are production-capable and validated against positive/negative vectors.
