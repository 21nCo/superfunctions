# Phase goal

Replace convenience-only in-process provider-policy persistence with explicit durable store interfaces and deterministic ID generation.

# In scope / Out of scope

- In scope: `oauth-providers` persistence interfaces, default in-memory stores, async registry methods, tests
- Out of scope: consumer adoption in downstream packages, docs inventory beyond API-facing references

# Deliverables

- `packages/oauth-providers/src/index.ts`
- `packages/oauth-providers/src/policy-registry.ts`
- `packages/oauth-providers/src/stores.ts` or equivalent persistence module
- `packages/oauth-providers/tests/policy-registry.test.ts`

# Requirements covered

- `PROVIDER-001`
- `TEST-001`
- `COMPAT-001`

# Implementation tasks

1. Introduce explicit persistence interfaces for consent and policy audit events.
2. Rework `ProviderPolicyRegistry` to persist through async stores instead of process-local arrays.
3. Add deterministic test ID injection and remove `Math.random()` usage.
4. Preserve a convenience default registry path backed by in-memory stores.
5. Add deterministic tests for successful durable persistence, unknown providers, and store write failures.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-providers`
- Expected outcome: provider-policy decisions and audit events are storable through async stores, default in-memory mode still works, and write failures surface deterministic errors.

# Stop condition

Report the final persistence interfaces, the default-store behavior, and the chosen deterministic ID strategy.

