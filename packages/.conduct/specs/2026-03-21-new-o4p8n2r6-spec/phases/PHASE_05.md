# Phase goal

Update shared CLI discovery/schema generation and expand shared test fixtures.

# In scope / Out of scope

- In scope: `packages/cli`, `packages/oauth-testing`
- Out of scope: Python adapter hardening

# Deliverables

- `packages/cli/src/utils/discover-packages.ts`
- `packages/cli/src/utils/discover-configs.ts`
- `packages/cli/src/utils/load-library-config.ts`
- `packages/cli/src/utils/schema-generators.ts`
- `packages/cli/src/__tests__/discover-configs.test.ts`
- `packages/cli/src/__tests__/authfn-schema-discovery.test.ts`
- `packages/oauth-testing/src/index.ts`
- `packages/oauth-testing/src/browser-auth-fixtures.ts`

# Requirements covered

- `CLI-001`
- `TEST-001`

# Implementation tasks

1. Ensure scoped multi-package auth libraries are discoverable.
2. Ensure plugin-rich config objects can be passed into `getSchema()`.
3. Add fixtures for browser-auth OAuth and authfn schema composition.
4. Add redaction-safe snapshot rules.

# Verification steps

- Run `npm test --workspace @superfunctions/cli`
- Run `npm test --workspace @superfunctions/oauth-testing`
- Expected outcome: `@authfn/core` schema discovery works and fixtures are reusable by authfn tests.

# Stop condition

Report discovery behavior, new fixtures, and schema generation guarantees.
