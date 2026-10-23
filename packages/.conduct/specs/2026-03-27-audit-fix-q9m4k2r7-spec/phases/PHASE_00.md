# Phase goal

Align canonical type ownership and runtime-config resolver parity across `oauth-core`, `oauth-http`, and `oauth-flow`.

# In scope / Out of scope

- In scope: lower-level type ownership, `oauth-flow` public config shape, resolver precedence, export cleanup
- Out of scope: token-storage hardening, disconnect cleanup semantics, router defaults, docs repairs

# Deliverables

- `packages/oauth-core/src/index.ts`
- `packages/oauth-core/src/service.ts`
- `packages/oauth-http/src/index.ts`
- `packages/oauth-flow/src/index.ts`
- `packages/oauth-flow/src/service.ts`
- `packages/oauth-flow/src/__tests__/exports.test.ts`
- `packages/oauth-flow/src/__tests__/start-callback.test.ts`
- `packages/oauth-core/src/__tests__/browser-auth-intents.test.ts`

# Requirements covered

- `FLOW-001`
- `COMPAT-001`

# Implementation tasks

1. Remove local duplicate type declarations from `packages/oauth-flow/src/service.ts`.
2. Import canonical runtime-config and secret-resolution symbols from `oauth-core` and `oauth-http`.
3. Extend `OAuthFlowServiceConfig` to accept both `providerRuntimeConfig` and `resolveProviderRuntimeConfig`.
4. Define and document resolver precedence, including `undefined` handling for operation-specific fields that do not exist.
5. Add or update tests that prove resolver precedence and stable error behavior for missing `clientId`.
6. Preserve compatibility re-exports where practical and document any alias behavior.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-core`
- Run `npm test --workspace @superfunctions/oauth-flow`
- Expected outcome: resolver precedence is deterministic, missing runtime config still fails with `OAUTH_RUNTIME_CONFIG_INVALID`, and `oauth-flow` no longer owns duplicate lower-level type definitions.

# Stop condition

Report the final canonical owner for each shared type touched in this phase and the exact resolver precedence rules implemented in `oauth-flow`.

