# Phase 03: Single-process runner and run step

## Phase goal
Runner process that pulls job from flowfn, executes only `run` (shell) steps in a workspace, reports step/job status and logs to control plane and logfn.

## In scope
- Runner: poll or subscribe to flowfn for job; on receive, create workspace (temp dir); for each step, if type run execute shell command; report step started/completed/failed to control plane (store update or API); send log lines to logfn.
- Control plane: update job/step status when runner reports; optional endpoint for runner to PATCH job/step status and append logs (or runner uses store directly if same process).
- logfn client in runner: emit step stdout/stderr as log entries (runId, jobKey, stepId, line).
- Only step type `run` implemented; other step types (checkout, cache, artifact, testfn, hostfn) out of scope for this phase.

## Out of scope
- Checkout, cache, artifact, testfn, hostfn steps; expressions (if, env ${{ }}); secrets; Docker runner.

## Deliverables
- `cifn/typescript/runner/src/executor/run-step.ts` (execute shell in workspace).
- `cifn/typescript/runner/src/runner.ts` (loop: dequeue job, run steps, report).
- `cifn/typescript/runner/src/reporting/logfn-client.ts` (send log lines).
- Control plane: PATCH /runs/:runId/jobs/:jobKey/steps/:stepId (status, logs) or store update from runner.
- Tests: end-to-end one run with one job and two run steps; verify job completes and logs visible.

## Requirements covered
- RUNNER-001 (default runner), RUNNER-003, RUNNER-005, RUN-003, INT-004, OBS-001.

## Implementation tasks
1. Runner package: init package.json, tsconfig; add flowfn client to dequeue job.
2. Executor for step type run: spawn shell (e.g. child_process.exec or execSync with timeout); capture stdout/stderr; return exit code and output.
3. Runner loop: dequeue job; create temp workspace; for each step in job, if run execute and report status (pending → running → success/failure); on step failure mark job failed and stop; on all success mark job completed; enqueue dependent jobs (Phase 02 DAG: jobs that have all needs satisfied).
4. logfn client: append log line(s) with runId, jobKey, stepId; if logfn not available, write to control plane store or in-memory buffer for tests.
5. Control plane: provide way to update step/job status and attach logs (API PATCH or shared store). GET /runs/:runId/jobs/:jobKey/logs returns collected logs.
6. Add test: create run with one job and two run steps (echo 1, echo 2); start runner; assert run completes success and logs contain "1" and "2".

## Verification steps
- Start control plane; create run with pipeline: one job, steps [run: echo hello, run: echo world]. Start runner. Wait for run to complete.
- GET /runs/:runId → status success; job status success; steps success.
- GET /runs/:runId/jobs/build/logs → log lines contain "hello" and "world".
- Run test suite: `npm test` in runner and control-plane.

## Stop condition
- End-to-end run with run steps completes; status and logs correct; TV-RUN-002 (job order) and TV-OBS-001 (events logged) pass. Report: "Phase 03 complete; single-process runner with run step and logfn ready for Phase 04 (triggers, checkout)."
