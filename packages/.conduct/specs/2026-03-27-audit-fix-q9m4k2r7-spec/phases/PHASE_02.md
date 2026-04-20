# Phase goal

Fix `oauth-flow` disconnect reporting so cleanup flags are truthful and hook-driven instead of synthetic.

# In scope / Out of scope

- In scope: disconnect result envelope, disconnect hook context, hook result validation, cleanup alias compatibility
- Out of scope: router metadata defaults, provider-policy persistence, docs inventory

# Deliverables

- `packages/oauth-flow/src/service.ts`
- `packages/oauth-flow/src/index.ts`
- `packages/oauth-flow/src/__tests__/refresh-disconnect.test.ts`
- `packages/oauth-flow/src/__tests__/exports.test.ts`

# Requirements covered

- `FLOW-003`
- `FLOW-004`
- `COMPAT-001`

# Implementation tasks

1. Add structured `connectionCleanup` reporting to the disconnect result.
2. Preserve `connectionDeleted` as a deprecated alias and guarantee it mirrors the structured result.
3. Expand `onDisconnected` to receive normalized disconnect context, including subject/token metadata when available.
4. Validate disconnect hook return shapes and surface invalid values deterministically.
5. Ensure local token cleanup happens before hook failure or revoke failure is surfaced.
6. Update tests for no-hook, successful-hook, throwing-hook, and invalid-hook-return cases.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-flow`
- Expected outcome: disconnect results are truthful in all cases, hook failures do not roll back local token cleanup, and alias compatibility stays intact.

# Stop condition

Report the final disconnect result shape and the exact semantics for `attempted`, `deleted`, and `reason`.

