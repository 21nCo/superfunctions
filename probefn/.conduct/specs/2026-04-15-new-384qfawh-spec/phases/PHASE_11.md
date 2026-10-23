# Phase goal

Implement auth-profile persistence and final sensitive-data hardening across exports and baseline operations.

# In scope / Out of scope

- In scope: auth-profile save/load, export exclusion, redaction review across all paths, instability metadata propagation.
- Out of scope: fixture-suite docs and final performance tuning.

# Deliverables

- `packages/core/src/auth-profiles.ts`
- `packages/core/test/auth-profiles.test.ts`
- `packages/storage/src/export-filters.ts`
- `apps/cli/src/commands/auth.ts`
- `packages/mcp-server/src/tools/auth.ts`
- `test/fixtures/vite-auth/`
- `test/fixtures/vite-secret-leak/`

# Requirements covered

- `AUTH-001`
- `SECURITY-001`
- `DETERMINISM-002`

# Implementation tasks

1. Implement auth-profile save and load using Playwright storage state.
2. Exclude auth-profile artifacts from reports and baseline bundles by default.
3. Re-run the redaction pipeline across report export and baseline export paths.
4. Ensure instability metadata continues to propagate through exported findings and reports.
5. Add authenticated fixture tests and secret-leak redaction tests.

# Verification steps

1. Run `pnpm --filter @probefn/core test`.
   Expected outcome: auth-profile tests pass.
2. Run `pnpm probefn auth profile save --session sess_auth --profile customer-admin --json`.
   Expected outcome: saved profile path is returned.
3. Run the secret-leak fixture flow and export a report.
   Expected outcome: secrets are redacted and auth-profile artifacts are absent from exported reports.

# Stop condition

Report one saved profile path, one missing-profile error, and one redacted export example before starting Phase 12.
