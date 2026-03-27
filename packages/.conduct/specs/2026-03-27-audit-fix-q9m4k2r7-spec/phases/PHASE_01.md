# Phase goal

Make encrypted token storage the default `oauth-flow` behavior and preserve plaintext storage only as an explicit unsafe mode.

# In scope / Out of scope

- In scope: `oauth-flow` token-storage mode, unsafe-storage error handling, encrypted-vault tests
- Out of scope: disconnect cleanup semantics, docs/README updates, router defaults

# Deliverables

- `packages/oauth-flow/src/service.ts`
- `packages/oauth-flow/src/index.ts`
- `packages/oauth-flow/src/__tests__/start-callback.test.ts`
- `packages/oauth-flow/src/__tests__/refresh-disconnect.test.ts`
- `packages/oauth-flow/src/__tests__/browser-auth-flow.test.ts`

# Requirements covered

- `FLOW-002`
- `FLOW-004`
- `COMPAT-001`

# Implementation tasks

1. Introduce an explicit token-storage mode on `OAuthFlowServiceConfig`.
2. Reject non-encrypted vaults in the default mode before any token record is persisted.
3. Preserve an explicit unsafe plaintext mode for tests/prototypes.
4. Add deterministic `OAUTH_TOKEN_STORAGE_UNSAFE` error handling and failure event emission.
5. Update tests so encrypted vaults succeed, unsafe plaintext is opt-in, and event details stay redaction-safe.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-flow`
- Expected outcome: encrypted-required mode is the default, plaintext storage fails without opt-in, and failure paths stay redaction-safe.

# Stop condition

Report the final token-storage mode API, the exact unsafe-mode name, and the emitted error/event behavior for rejected plaintext storage.

