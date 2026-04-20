# Phase goal

Ship the fixture suite, operator docs, and full end-to-end verification for the complete local-first framework.

# In scope / Out of scope

- In scope: fixture apps, golden-vector runner, repo docs, final integration verification, local-first policy validation.
- Out of scope: new product scope beyond this spec.

# Deliverables

- `test/fixtures/vite-healthy/`
- `test/fixtures/vite-overflow/`
- `test/fixtures/vite-token-drift/`
- `test/fixtures/vite-regression/`
- `test/fixtures/vite-console-error/`
- `test/fixtures/vite-auth/`
- `docs/getting-started.md`
- `docs/agent-consumption.md`
- `docs/artifacts.md`
- `docs/baselines.md`
- `package.json` (add `test:vectors`)
- `README.md`

# Requirements covered

- `RUNTIME-001`
- `TEST-001`
- `DOC-001`

# Implementation tasks

1. Complete all fixture applications and flow files needed by the golden vectors.
2. Add a repo-root `test:vectors` command that executes the golden-vector suite locally.
3. Write docs for setup, config, CLI usage, MCP usage, artifact layout, design audits, and baseline workflow.
4. Verify no framework feature requires a remote service for core operation.
5. Run the full end-to-end suite from repo root and fix any remaining contract drift.

# Verification steps

1. Run `pnpm test:vectors`.
   Expected outcome: all vectors pass locally.
2. Run `pnpm turbo run test typecheck`.
   Expected outcome: all packages pass tests and typechecking.
3. Run a manual smoke flow:
   - `pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json`
   - `pnpm probefn checkpoint create --session sess_healthy --name landing --json`
   - `pnpm probefn audit design --session sess_healthy --checkpoint chk_landing --json`
   Expected outcome: all commands succeed without remote dependencies.

# Stop condition

Report the final vector count, the docs created, and confirmation that the framework operates fully local-first before marking the spec complete.
