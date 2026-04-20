# Phase goal

Implement config-loader and env-reading helpers for generic CLI builders.

# In scope / Out of scope

- In scope:
  - `clifn/config-loader`
  - `clifn/env`
  - TS/JS/JSON config loading
  - candidate discovery
  - validation hooks
  - deterministic env parsing
- Out of scope:
  - product-specific config shapes
  - diagnostics formatting
  - parser integrations

# Deliverables

- Create `clifn/core/src/config-loader.ts`
- Create `clifn/core/src/env.ts`
- Modify `clifn/core/src/index.ts`
- Create `clifn/core/tests/config-loader.test.ts`
- Create `clifn/core/tests/env.test.ts`
- Modify `clifn/core/README.md`

# Requirements covered

- `CFG-001`
- `ENV-001`
- `SEC-001`

# Implementation tasks

- Extract or adapt one shared TS/JS/JSON loader path informed by `packages/cli` and `apifn/cli`.
- Support deterministic candidate discovery and explicit config-path mode.
- Support configurable validation hooks and export-name preference.
- Compose `@superfunctions/config` semantics where appropriate for env parsing.
- Add explicit error codes for missing config, unsupported extensions, and invalid env values.
- Add tests covering TS load, JSON load, explicit path failure, required env, int bounds, and boolean parsing.

# Verification steps

- Run `npm run test -- --filter=clifn -- config-loader env`
- Expected outcomes:
  - config files load deterministically
  - required env failures are explicit
  - `.ts` loading does not create a third incompatible repository pattern

# Stop condition

Stop after config loading and env helpers are stable enough for downstream CLIs to consume.

