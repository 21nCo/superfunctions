# Phase Completion Report

- Timestamp: `2026-04-15T13:44:19Z`
- Agent: `codex`
- Model: `gpt-5`
- Launcher: `Codex Desktop`
- Repo root: `.`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git: `branch=main`, `commit=none yet`, `dirty=true`

## Phase

- `PHASE_02`
- Status: `PASS`

## Requirements Summary

- Requirements delivered: `DEV-001`, `DEV-002`, `SESSION-001`

### `DEV-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Spawn mode starts a configured command, detects readiness, and exposes the resolved URL:
    - `packages/dev-server/test/dev-server-manager.test.ts` starts the healthy fixture in `spawn` mode and asserts `resolvedUrl === "http://127.0.0.1:4173/"`.
    - `pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode debug --browser chromium --json` returned a success envelope with `sessionId`, `runId`, `artifactRoot`, `startedAt`, and `resolvedUrl`.
  - Attach mode validates that the configured URL is reachable before the session becomes ready:
    - `packages/dev-server/test/dev-server-manager.test.ts` starts an in-process HTTP server on `127.0.0.1:4175` and verifies attach mode succeeds.
    - The same test file verifies unreachable attach mode fails with `E_URL_UNREACHABLE`.
  - Unsupported or malformed dev-server specs are rejected with structured config or runtime errors:
    - `packages/dev-server/src/dev-server-manager.ts` rejects missing `command` or `url` for spawn mode with `E_CONFIG_INVALID`.
    - `packages/dev-server/src/readiness.ts` rejects invalid `readyPattern` with `E_CONFIG_INVALID`.
- Test status:
  - Passed via `pnpm --filter @probefn/dev-server test`
  - Covered by `packages/dev-server/test/dev-server-manager.test.ts`

### `DEV-002`

- Status: `PASS`
- Acceptance criteria evidence:
  - Stdout and stderr are captured into separate append-only sinks:
    - `packages/dev-server/src/dev-server-manager.ts` creates `stdout` and `stderr` event sinks through `ArtifactStore.createEventSink(...)`.
    - Sink paths are persisted in the started session object and manifest under `.artifacts/runs/<runId>/devserver/stdout.ndjson` and `.artifacts/runs/<runId>/devserver/stderr.ndjson`.
  - Early process exit before readiness emits `E_DEVSERVER_EXIT_EARLY`:
    - `packages/dev-server/src/dev-server-manager.ts` raises `E_DEVSERVER_EXIT_EARLY` from the child `exit` monitor when readiness has not settled.
  - Readiness timeout emits `E_DEVSERVER_START_TIMEOUT`:
    - `packages/dev-server/test/dev-server-manager.test.ts` verifies the hanging fixture fails with `code: "E_DEVSERVER_START_TIMEOUT"` and message `Dev server did not become ready within 300ms.`
  - Server restarts or instability are recorded in the run or checkpoint metadata:
    - `packages/dev-server/src/process-events.ts` marks instability on `hmr update`, `hmr invalidate`, `page reload`, `restarting`, `restart`, and `hot update`.
    - The healthy spawn test emits `hmr update /src/main.tsx` and verifies `manifest.unstable === true`.
- Test status:
  - Passed via `pnpm --filter @probefn/dev-server test`
  - Covered by `packages/dev-server/test/dev-server-manager.test.ts`

### `SESSION-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Starting a session writes a run manifest with session ID, run ID, mode, browser, deterministic settings, and artifact root:
    - `packages/dev-server/src/dev-server-manager.ts` creates the run manifest at session start through `createRunManifest(...)` and `ArtifactStore.writeRunManifest(...)`.
    - The healthy and timeout tests read `runs/<runId>/session.json` and assert manifest contents.
  - Starting a second active run for the same session returns `E_SESSION_ALREADY_RUNNING`:
    - `packages/dev-server/test/dev-server-manager.test.ts` verifies duplicate attach starts for `sess_attach` fail with `E_SESSION_ALREADY_RUNNING`.
  - Stopping or failing a run finalizes status and timestamps in the manifest:
    - The healthy spawn test verifies the manifest becomes `completed` with `endedAt`.
    - The timeout test verifies the manifest becomes `failed` with `endedAt`.
- Test status:
  - Passed via `pnpm --filter @probefn/dev-server test`
  - Covered by `packages/dev-server/test/dev-server-manager.test.ts`

## Deliverables Summary

- Files changed/added:
  - `package.json`
  - `packages/contracts/src/manifests.ts`
  - `packages/dev-server/package.json`
  - `packages/dev-server/tsconfig.json`
  - `packages/dev-server/src/index.ts`
  - `packages/dev-server/src/cli.ts`
  - `packages/dev-server/src/dev-server-manager.ts`
  - `packages/dev-server/src/process-events.ts`
  - `packages/dev-server/src/readiness.ts`
  - `packages/dev-server/test/dev-server-manager.test.ts`
  - `packages/storage/src/event-sink.ts`
  - `test/fixtures/vite-healthy/server.mjs`
  - `test/fixtures/vite-healthy/probefn.config.ts`
  - `test/fixtures/vite-hangs/server.mjs`
  - `test/fixtures/vite-hangs/probefn.config.ts`
- Files deleted/modified:
  - Deleted stale snapshot file `packages/dev-server/test/__snapshots__/dev-server-manager.test.ts.snap` after replacing it with direct contract assertions.

## Verification Summary

- Phase verification steps executed:
  - `pnpm --filter @probefn/dev-server test` -> `PASS`
  - `pnpm --filter @probefn/dev-server typecheck` -> `PASS`
  - `pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode debug --browser chromium --json` -> `PASS`
- Test execution results:
  - `vitest`: `4 passed`, `0 failed`
  - `typecheck`: no TypeScript errors
  - Smoke command output included:
    - `sessionId: "sess_1776260625240"`
    - `runId: "run_1776260625240"`
    - `artifactRoot: ".artifacts/runs/run_1776260625240"`
    - `resolvedUrl: "http://127.0.0.1:4173/"`

## Notes

- Readiness detection uses configurable regex compilation plus Vite-compatible defaults:
  - `/Local:\s+(https?:\/\/[^\s]+)/i`
  - `/ready in\s+\d+/i`
- Resolved URLs are extracted from the matching line when present; otherwise the configured URL remains authoritative.
- Stdout and stderr are normalized into separate NDJSON sinks under `.artifacts/runs/<runId>/devserver/`.
- Attach mode uses repeated `fetch(...)` probes with a 1 second per-request abort and 100ms retry cadence until the configured timeout is reached.
- Spawn mode now serializes child-exit manifest persistence with stop/fail finalization so atomic manifest rewrites do not race.
- The negative timeout test observed the exact structured error:
  - `code: "E_DEVSERVER_START_TIMEOUT"`
  - `message: "Dev server did not become ready within 300ms."`
- The repo-root `pnpm probefn session start ...` smoke command was required by this phase even though the full CLI is formally specified later; a narrow phase-local CLI entrypoint was added to satisfy the mandated verification surface without expanding beyond `session start`.
- The execution skill expects `.conduct/{spec_folder}/...`, but this repository’s spec bundle lives under `.conduct/specs/{spec_folder}/...`; reporting and log updates followed the existing repo structure for consistency with prior phases.
- Commands emitted a Node engine warning because the environment is `node v20.20.0` while the package manifest requests `>=22.0.0`; all phase verification commands still completed successfully in this environment.

## Ready For Next Phase?

- Yes. `PHASE_03` can build on the dev-server manager, run manifest lifecycle, and separate dev-server sink outputs implemented here.

## Blockers

- None.
