# Phase goal

Extend shared OAuth core, HTTP, and storage packages for browser-auth intents and runtime secret resolution.

# In scope / Out of scope

- In scope: `oauth-core`, `oauth-http`, `oauth-storage`
- Out of scope: route factories and OpenAPI generation

# Deliverables

- `packages/oauth-core/src/index.ts`
- `packages/oauth-core/src/service.ts`
- `packages/oauth-http/src/index.ts`
- `packages/oauth-http/src/token-client.ts`
- `packages/oauth-http/src/errors.ts`
- `packages/oauth-storage/src/index.ts`
- `packages/oauth-storage/src/state-store.ts`
- `packages/oauth-storage/src/token-vault.ts`
- `packages/oauth-storage/src/adapters/db.ts`
- `packages/oauth-storage/src/adapters/sql.ts`
- `packages/oauth-core/src/__tests__/browser-auth-intents.test.ts`
- `packages/oauth-storage/tests/shared-schema.test.ts`

# Requirements covered

- `OAUTH-CORE-001`
- `OAUTH-HTTP-001`
- `OAUTH-STORAGE-001`

# Implementation tasks

1. Add browser-auth intent subject types to `oauth-core`.
2. Add runtime secret resolver support and structured errors to `oauth-http`.
3. Add shared consent/revocation stores and schema definitions to `oauth-storage`.
4. Add tests for state replay and runtime secret failure handling.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-core`
- Run `npm test --workspace @superfunctions/oauth-http`
- Run `npm test --workspace @superfunctions/oauth-storage`
- Expected outcome: browser-auth intents are valid, reusable schemas exist, and secret resolution errors are structured.

# Stop condition

Report the final intent model, secret resolver interface, and storage table inventory.
