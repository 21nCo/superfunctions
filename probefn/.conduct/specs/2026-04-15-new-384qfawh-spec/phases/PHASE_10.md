# Phase goal

Implement the CLI command surface, flow-runner UX, and canonical JSON/error output.

# In scope / Out of scope

- In scope: command parsing, repo-root command UX, flow execution files, JSON output mode, exit codes.
- Out of scope: fixture authoring and final documentation polish.

# Deliverables

- `apps/cli/src/index.ts`
- `apps/cli/src/commands/session.ts`
- `apps/cli/src/commands/page.ts`
- `apps/cli/src/commands/checkpoint.ts`
- `apps/cli/src/commands/design.ts`
- `apps/cli/src/commands/baseline.ts`
- `apps/cli/src/commands/auth.ts`
- `apps/cli/src/commands/report.ts`
- `apps/cli/src/commands/flow.ts`
- `apps/cli/src/output/json.ts`
- `apps/cli/src/output/human.ts`
- `apps/cli/test/cli.test.ts`
- `test/fixtures/vite-console-error/flows/trigger-error.yaml`

# Requirements covered

- `API-001`
- `ERROR-001`
- `EVENT-002`

# Implementation tasks

1. Implement every CLI command defined in `SPEC.md`.
2. Implement canonical `--json` serialization and human-readable output.
3. Implement flow-file execution using repo-root relative paths.
4. Map structured errors to predictable exit codes without losing the canonical JSON envelope.
5. Add CLI integration tests for success, validation failure, and session-not-found failure.

# Verification steps

1. Run `pnpm --filter @probefn/cli test`.
   Expected outcome: CLI tests pass.
2. Run `pnpm probefn page find --session sess_healthy --query "Save button" --json`.
   Expected outcome: canonical success JSON is printed.
3. Run `pnpm probefn page find --session sess_missing --query "Save button" --json`.
   Expected outcome: canonical error JSON with `E_SESSION_NOT_FOUND` is printed.

# Stop condition

Report one successful CLI JSON payload, one failing CLI JSON payload, and the implemented flow-file format before starting Phase 11.
