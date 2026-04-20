# Phase goal

Make the shared OAuth family verifiable from `repo root` through reproducible package-local tests and a dedicated repo-root release gate.

# In scope / Out of scope

- In scope: package test/build resolution, repo-root gate script, documented verification commands, integrated regression pass
- Out of scope: downstream consumer gates outside the shared OAuth family

# Deliverables

- `package.json`
- `turbo.json` if gate wiring requires it
- `scripts/gate-packages-oauth-shared.mjs` or equivalent repo-root gate module
- `packages/oauth-core/package.json`
- `packages/oauth-http/package.json`
- `packages/oauth-storage/package.json`
- `packages/oauth-providers/package.json`
- `packages/oauth-flow/package.json`
- `packages/oauth-testing/package.json`
- `packages/oauth-router/package.json`
- `packages/oauth-core/vitest.config.ts` or equivalent test-resolution config
- `packages/oauth-http/vitest.config.ts` or equivalent test-resolution config
- `packages/oauth-storage/vitest.config.ts` or equivalent test-resolution config
- `packages/oauth-providers/vitest.config.ts` or equivalent test-resolution config
- `packages/oauth-flow/vitest.config.ts` or equivalent test-resolution config
- `packages/oauth-testing/vitest.config.ts` or equivalent test-resolution config
- `packages/oauth-router/vitest.config.ts` or equivalent test-resolution config

# Requirements covered

- `GATE-001`
- `TEST-001`

# Implementation tasks

1. Define the canonical repo-root gate command for the shared OAuth family.
2. Make package-local test commands resolve sibling workspaces without requiring manual `dist` prebuilds.
3. Ensure the gate covers build, tests, and docs inventory for the audited OAuth family.
4. Document the gate in the relevant READMEs or shared docs pages.
5. Run the integrated gate and capture any remaining package-resolution gaps before closing the phase.

# Verification steps

- Run `npm run gate:packages-oauth-shared`
- Run `npm test --workspace @superfunctions/oauth-core`
- Run `npm test --workspace @superfunctions/oauth-http`
- Run `npm test --workspace @superfunctions/oauth-storage`
- Run `npm test --workspace @superfunctions/oauth-providers`
- Run `npm test --workspace @superfunctions/oauth-flow`
- Run `npm test --workspace @superfunctions/oauth-testing`
- Run `npm test --workspace @superfunctions/oauth-router`
- Expected outcome: every command exits `0` from `repo root`, and no command depends on a manually prebuilt sibling `dist` tree.

# Stop condition

Report the final gate command, the package-local test strategy, and any residual verification assumptions that remain after all commands pass.
