# Phase goal

Implement secure OAuth core logic and durable state/token persistence primitives.

## In scope / Out of scope

- **In scope**:
  - Auth URL generation with PKCE/state/nonce.
  - Callback state consume semantics.
  - Token vault encryption interfaces and adapters.
- **Out of scope**:
  - Provider-specific token transport details.
  - `plugfn` migration.

## Deliverables

- `packages/oauth-core/src/service.ts`
- `packages/oauth-core/src/pkce.ts`
- `packages/oauth-core/src/state.ts`
- `packages/oauth-storage/src/state-store.ts`
- `packages/oauth-storage/src/token-vault.ts`
- `packages/oauth-storage/src/adapters/memory.ts`
- `packages/oauth-storage/src/adapters/sql.ts` (or equivalent durable adapter)
- `packages/oauth-core/tests/oauth-core.test.ts`
- `packages/oauth-storage/tests/state-vault.test.ts`

## Requirements covered

- OAUTH-001
- OAUTH-002
- OAUTH-003
- OAUTH-005

## Implementation tasks

1. Implement cryptographically secure state and PKCE generation.
2. Add one-time state consumption semantics with atomic store operations.
3. Implement token vault contract with encrypted payload + key reference fields.
4. Add expiry cleanup primitives for states.
5. Write positive/negative tests for replay, expiry, and encryption failure paths.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions && npm run test --workspace @superfunctions/oauth-core`
2. `cd /Users/serro/Documents/dev/n/superfunctions && npm run test --workspace @superfunctions/oauth-storage`
3. `cd /Users/serro/Documents/dev/n/superfunctions && npm run typecheck --workspace @superfunctions/oauth-core`
Expected outcome: tests and typecheck pass; replay/expiry negative tests assert required error codes.

## Stop condition

OAuth core and storage packages pass replay/expiry/encryption tests and are ready for transport-layer integration.
