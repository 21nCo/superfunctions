# Phase goal

Update shared provider registry and runtime provider behavior for Google, Apple, and GitHub.

# In scope / Out of scope

- In scope: `oauth-providers`, runtime provider policy tests
- Out of scope: CLI and OpenAPI

# Deliverables

- `packages/oauth-providers/src/index.ts`
- `packages/oauth-providers/src/policy-registry.ts`
- `packages/oauth-providers/src/providers/google.ts`
- `packages/oauth-providers/src/providers/apple.ts`
- `packages/oauth-providers/src/providers/github.ts`
- `packages/oauth-providers/tests/provider-runtime.test.ts`

# Requirements covered

- `PROVIDER-001`
- `OAUTH-HTTP-001`

# Implementation tasks

1. Normalize provider descriptors for the three required auth providers.
2. Add policy coverage for auth-oriented usage, not only plugfn-style capabilities.
3. Ensure Apple runtime behavior can be expressed without static embedded secrets.
4. Add deterministic provider policy tests.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-providers`
- Expected outcome: Google, Apple, and GitHub provider descriptors/policies are stable and compatible with runtime secret resolution.

# Stop condition

Report provider descriptor fields, policy coverage, and Apple runtime behavior.
