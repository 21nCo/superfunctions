# Phase goal

Implement the dev-server manager for spawn and attach modes with readiness detection and instability tracking.

# In scope / Out of scope

- In scope: process spawning, attach validation, readiness regex handling, stdout/stderr capture, restart detection.
- Out of scope: browser interactions, page-model logic, analyzers.

# Deliverables

- `packages/dev-server/package.json`
- `packages/dev-server/src/index.ts`
- `packages/dev-server/src/dev-server-manager.ts`
- `packages/dev-server/src/readiness.ts`
- `packages/dev-server/src/process-events.ts`
- `packages/dev-server/test/dev-server-manager.test.ts`
- `test/fixtures/vite-healthy/`
- `test/fixtures/vite-hangs/`

# Requirements covered

- `DEV-001`
- `DEV-002`
- `SESSION-001`

# Implementation tasks

1. Implement `spawn` and `attach` session-start adapters.
2. Stream stdout and stderr into the storage package sinks.
3. Detect readiness via configurable regex and Vite-compatible defaults.
4. Detect early exit, timeout, and restart/instability markers.
5. Add fixture-backed integration tests for healthy startup, timeout, and unreachable attach URLs.

# Verification steps

1. Run `pnpm --filter @probefn/dev-server test`.
   Expected outcome: spawn and attach integration tests pass.
2. Run `pnpm --filter @probefn/dev-server typecheck`.
   Expected outcome: no type errors.
3. Run a local smoke command: `pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode debug --browser chromium --json`.
   Expected outcome: session JSON includes a session ID, run ID, and resolved local URL.

# Stop condition

Report the readiness-detection logic used, the sink paths for stdout/stderr, and the exact timeout error observed in the negative test before starting Phase 03.
