# CiFn Implementation Plan

## Architecture sketch

- **Control plane** (Node.js): HTTP API, pipeline parser/validator, run/job/step state store, flowfn queue client, trigger handlers (webhook, cron, API), runner registration and job dispatch. Reads pipeline from repo (git clone or plugfn) or from request body for workflow_dispatch.
- **Runner** (Node.js or container): Polls or receives job from control plane (via flowfn or direct); executes steps in workspace (shell, checkout, cache, artifact, testfn, hostfn); reports logs to logfn and status to control plane; supports default and hostfn-runner types.
- **Pipeline schema**: JSON Schema in `schemas/pipeline.schema.json`; used by control plane and CLI for validation.
- **CLI**: `cifn` (run, status, logs); reads local config; calls control plane API; no secret output.
- **Dashboard**: Static or SPA (uifn/docsfn style); calls control plane API with same auth; run list, run detail, logs, artifacts.

**Module responsibilities**:
- `control-plane/api`: Routes, auth middleware, request/response envelope.
- `control-plane/pipeline`: Parse YAML/JSON, validate against schema, resolve DAG.
- `control-plane/queue`: flowfn enqueue/dequeue; job payload shape.
- `control-plane/triggers`: Webhook handler (verify + create run), cron (flowfn scheduler), workflow_dispatch (API body).
- `control-plane/runners`: Register, heartbeat, assign job to runner.
- `control-plane/store`: Run/Job/Step persistence (DB or flowfn-backed).
- `runner/executor`: Step runner (run, checkout, cache, artifact, testfn, hostfn).
- `runner/reporting`: logfn client, status updates to control plane.
- `sdk`: Optional TypeScript client for API (create run, list runs, get run).

## Dependency graph

1. **Pipeline schema + parser + validator** (no runtime deps on flowfn/filefn): Must exist first so that API and runner can parse pipeline.
2. **Control plane store** (in-memory or DB): Required for runs/jobs/steps before API can return them.
3. **flowfn client** (enqueue/dequeue): Required for run creation and runner job claim.
4. **Control plane API** (create run, get run, list runs, cancel, logs, artifacts): Depends on store and queue.
5. **Runner (single process)** with run step only: Depends on queue (pull job) and control plane (report status/logs). Depends on logfn client.
6. **Checkout step**: Depends on git or plugfn; trigger payload or pipelineRef.
7. **Triggers**: Webhook (plugfn or HMAC), cron (flowfn), workflow_dispatch (API). Depend on pipeline parser and run creation.
8. **filefn client**: For artifact upload/download and cache (if filefn-backed cache). Required for artifact steps.
9. **cachefn or filefn cache**: For cache/restore and cache/save steps.
10. **secfn client**: For secrets injection (job env, runner token, API key, webhook signing). Required for secure runs and hostfn step.
11. **testfn and hostfn steps**: Runner executor extensions; depend on testfn SDK and hostfn CLI.
12. **Docker runner + hostfn-runner**: Runner variants; depend on executor and control plane dispatch.
13. **CLI**: Depends on control plane API (and optional local run).
14. **Dashboard**: Depends on control plane API and auth.

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|-------|------|----------------------|--------------|
| 00 | Pipeline schema and validation | JSON Schema, parser (YAML/JSON), validator; all step types and triggers defined | Schema validates golden pipelines; invalid pipelines fail with PIPELINE_INVALID |
| 01 | Control plane core and API | Store (in-memory), POST/GET runs, GET runs/:id, cancel; envelope and error codes | TV-API-001 to TV-API-011 (subset possible without runners) |
| 02 | flowfn queue and run creation | Enqueue jobs on run create; pipeline fetch from repo or body; DAG resolution | Create run enqueues root jobs; GET run shows jobs |
| 03 | Single-process runner and run step | Runner pulls job, runs shell steps, reports status and logs to control plane; logfn client | End-to-end run with one job and run steps; TV-RUN-002, TV-OBS-001 |
| 04 | Triggers: webhook, cron, workflow_dispatch | Webhook endpoint (verify + create run), cron via flowfn, API body for workflow_dispatch; checkout step | Trigger each type creates run; checkout step populates workspace |
| 05 | Artifacts and cache steps | filefn upload/download steps; cache restore/save (cachefn or filefn) | TV-INT-002, TV-INT-003, TV-API-014 |
| 06 | Secrets and testfn/hostfn steps | secfn injection for job env; testfn/run and hostfn/deploy steps | TV-SEC-003, TV-INT-004, TV-INT-006 |
| 07 | Runner registration and auth | Runner register with token (secfn); API auth (key/token); webhook verification | TV-RUNNER-002, TV-RUNNER-003, TV-SEC-001, TV-SEC-004 |
| 08 | CLI | cifn run, status, logs; config path; no secret output | TV-CLI-001 to TV-CLI-004 |
| 09 | Docker runner and hostfn-runner | Runner in Docker; hostfn-runner type and --local deploy | TV-RUNNER-001, TV-RUNNER-006 |
| 10 | Dashboard | Run list, run detail, logs, artifacts; auth | TV-DASH-001 |
| 11 | Limits, performance, optional sendfn | Enforce limits (doc size, jobs/steps/needs); optional sendfn notification | TV-LIMIT-001 to TV-LIMIT-003; TV-DASH-002 |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase are implemented and committed.
2. Verification steps for that phase pass (exact commands or manual steps as in phases/PHASE_XX.md).
3. Test vectors referenced in the phase are passing or explicitly scoped to a later phase.
4. No regressions: existing test vectors from earlier phases still pass.
