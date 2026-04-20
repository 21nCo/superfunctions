# Phase goal

Establish the Turborepo foundation, canonical contracts package, and validated config-loading pipeline.

# In scope / Out of scope

- In scope: repo tooling, workspace packages, shared TypeScript config, config schema loading, and base package wiring.
- Out of scope: browser automation, dev-server orchestration, analyzers, and reports.

# Deliverables

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`
- `apps/cli/package.json`
- `packages/contracts/package.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/config.ts`
- `packages/contracts/src/envelopes.ts`
- `packages/contracts/src/errors.ts`
- `packages/contracts/src/manifests.ts`
- `packages/contracts/test/config.test.ts`
- `probefn.config.ts.example`

# Requirements covered

- `ARCH-001`
- `CONFIG-001`
- `RUNTIME-001`

# Implementation tasks

1. Create all workspace package manifests and shared TS build settings.
2. Implement canonical config schemas, enums, defaults, and validation error formatting.
3. Export canonical response envelopes and error-code constants from `packages/contracts`.
4. Add config-loading unit tests for valid and invalid fixture configs.
5. Add a sample repo-root `probefn.config.ts.example` using repository-relative paths only.

# Verification steps

1. Run `pnpm install`.
   Expected outcome: workspace dependencies install successfully.
2. Run `pnpm turbo run typecheck`.
   Expected outcome: all created packages typecheck successfully.
3. Run `pnpm --filter @probefn/contracts test`.
   Expected outcome: config validation tests pass, including invalid browser-engine rejection.

# Stop condition

Report the package tree, the exported contract entrypoints, and the passing config-validation test names before starting Phase 01.
