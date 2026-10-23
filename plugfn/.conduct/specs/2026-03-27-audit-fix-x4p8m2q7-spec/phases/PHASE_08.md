# Phase goal

Add the authoritative repo-root PlugFn release gate and prove the final runtime with end-to-end OAuth and webhook checks.

# In scope / Out of scope

- In scope: repo-root release script wiring, TypeScript/CLI/Python verification, docs inventory, e2e OAuth + webhook checks, final status promotion rule
- Out of scope: new provider features outside the declared core set

# Deliverables

- `package.json`
- `plugfn/scripts/gate-plugfn-release.mjs`
- `plugfn/typescript/vitest.config.ts`
- `plugfn/cli/vitest.config.ts`
- `plugfn/python/pyproject.toml`
- `plugfn/typescript/tests/e2e/oauth-callback.test.ts`
- `plugfn/typescript/tests/e2e/webhook-verification.test.ts`
- `plugfn/docs/operations/release-gates.md`
- `plugfn/.conduct/STATUS.md`

# Requirements covered

- `REL-001`
- `DOCS-001`

# Implementation tasks

1. Define the canonical repo-root command `npm run gate:plugfn-release`.
2. Ensure TypeScript runtime, CLI, and Python verification commands all run from repo root.
3. Add docs inventory and portable-path checks into the gate.
4. Add one end-to-end OAuth callback test and one end-to-end webhook verification test to the gate.
5. Update `plugfn/.conduct/STATUS.md` so production-ready wording is only allowed after a passing gate on the same commit.

# Verification steps

- Run `npm run gate:plugfn-release`
- Run `npm test --workspace plugfn`
- Run `npm test --workspace @plugfn/cli`
- Run `python3 -m pytest -q plugfn/python/tests`
- Expected outcome: every command exits `0`, docs inventory passes, and the gate emits a deterministic release result without machine-specific paths.

# Stop condition

Report the final gate command, the end-to-end tests included, and the exact condition required before PlugFn may claim production readiness.
