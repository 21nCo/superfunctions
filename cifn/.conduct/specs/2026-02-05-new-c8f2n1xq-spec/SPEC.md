# CiFn Specification

## Metadata

- **timestamp**: 2026-02-05T12:00:00Z (UTC)
- **agent_name**: unknown-agent
- **model**: unknown
- **launcher**: Cursor
- **workspace path**: /Users/ar/dev (project: superfunctions/cifn)
- **project root**: /Users/ar/dev/superfunctions/cifn
- **OS**: darwin 25.0.0
- **shell**: zsh
- **repo**:
  - **git repo**: yes (parent superfunctions repo)
  - **branch**: as available at spec generation time
  - **commit**: as available
  - **dirty**: as available
- **spec_folder**: 2026-02-05-new-c8f2n1xq-spec
- **spec_folder full path**: cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec
- **spec_type**: new
- **spec_id**: c8f2n1xq
- **input paths**:
  - superfunctions/cifn/SPEC.md
  - agent/intent/super functions/superfunctions-ar-notes.md

## Overview

CiFn is a self-hosted CI/CD pipeline runner in the superfunctions ecosystem. It runs pipelines (build → test → deploy) on infrastructure the user controls, using hostfn, flowfn, testfn, logfn, watchfn, secfn, filefn, and plugfn. Pipelines are defined in YAML/JSON (familiar to GitHub Actions / CircleCI users). The control plane stores pipeline configs and run history, dispatches jobs via flowfn queues to runners that execute steps and report logs to logfn/watchfn. Artifacts use filefn; secrets use secfn. CiFn itself MAY be deployed via hostfn or Docker/Kubernetes.

**One-sentence goal**: Self-hosted CI/CD (like CircleCI/GitHub Actions) that integrates with the superfunctions ecosystem and is fully self-deployable.

**Target users**: Teams using superfunctions (hostfn, flowfn, testfn, etc.) who want CI/CD on their own infra without depending on a commercial CI vendor for execution.

**Target environments**: Server (Node.js). Control plane and runners run on Linux (VM or container). CLI may run on developer machines (Node.js). Offline execution of already-queued jobs is Undefined (network required for dispatch and reporting).

**Languages/packages**: TypeScript for control plane, runner, and SDK. Optional Python SDK. Integrations with flowfn, filefn, secfn, logfn, hostfn, testfn, plugfn (TypeScript/JS clients or HTTP where applicable).

**Existing systems**: MUST integrate with flowfn (job queue, DAG, cron), filefn (artifacts), secfn (secrets), logfn (logs), hostfn (deploy step), testfn (test step), plugfn (webhooks). MAY integrate with watchfn (metrics), sendfn (notifications).

**Data model**: Runs (id, pipelineRef, trigger, status, createdAt, updatedAt, jobs[]); Jobs (id, runId, jobKey, status, steps[], startedAt, completedAt); Steps (id, jobId, stepKey, status, logRef, startedAt, completedAt); Pipeline (name, on, env, jobs); Runner (id, labels, tokenHash, lastSeenAt). Relations: Run 1—* Job, Job 1—* Step; Pipeline is versioned by repo + ref.

**Security model**: Control plane API MUST authenticate callers (API key or token from secfn). Runners MUST authenticate to control plane (registration token from secfn). Job secrets MUST be injected from secfn only; MUST NOT be logged or persisted in plaintext. Webhook payloads MUST be verified (e.g. plugfn or HMAC). Multi-tenant: single-tenant by default; run isolation by runId/jobId.

**Performance constraints**: Pipeline parse + validation &lt; 500ms for configs up to 500KB. Job dispatch to runner &lt; 5s p99 when runner is available. Run listing with paging: &lt; 2s for 1000 runs. Artifact upload/download bounded by filefn limits. Scale: v1 fixed runners; queue depth bounded by flowfn.

**Non-goals**: Full GitHub Actions marketplace parity (use plugfn for integrations). Native Kubernetes job execution (v1 is process/container on VMs). Built-in SaaS offering (self-hosted first).

**Hard constraints**: Pipeline config MUST be validatable by a declared JSON Schema. All job secrets MUST come from secfn. Runner MUST NOT execute arbitrary code from the control plane except the declared step types (run, checkout, cache, artifact, testfn, hostfn). Determinism: given same pipeline + same trigger payload + same inputs, job order and step order MUST be deterministic; step output (logs, artifact content) MAY vary (e.g. timestamps, build hashes).

---

## Glossary

- **Pipeline**: A single document (YAML or JSON) defining name, triggers (on), global env, and jobs. Canonical after parse: PipelineSpec.
- **PipelineSpec**: Parsed and validated pipeline; immutable for a given run; includes resolved job DAG.
- **Run**: One execution of a pipeline triggered by an event (webhook, cron, API). Has unique runId, status (queued | running | success | failure | cancelled), and ordered list of jobs.
- **Job**: One of the named jobs in the pipeline; has jobKey (e.g. "build", "test"), status, and ordered steps. Jobs MAY have dependencies (needs); execution order MUST respect DAG.
- **Step**: One unit of work within a job: either `run` (shell) or `uses` (checkout, cache/restore, cache/save, artifact/upload, artifact/download, testfn/run, hostfn/deploy). Each step has status (pending | running | success | failure | skipped).
- **Control plane**: The CiFn server that exposes the API, parses pipelines, enqueues jobs to flowfn, stores run/job/step state, and assigns work to runners.
- **Runner**: A process or container that polls or receives jobs from the control plane, executes steps in a workspace, and reports logs and status back. Types: default (process or Docker), hostfn-runner (on hostfn-managed node), self-hosted (registered with token).
- **Trigger**: Event that starts a run: push, pull_request, schedule (cron), workflow_dispatch (API).
- **Artifact**: Named blob(s) produced by a step (e.g. dist/) stored in filefn and available to later jobs in the same run.
- **Cache**: Key-value store (cachefn or filefn) for restore/save steps; key MAY contain expressions (e.g. hashFiles).
- **Envelope**: Canonical response shape for API: `{ ok: true, data: T } | { ok: false, error: { code, message, details? } }`.
- **Expression**: `${{ ... }}` in config; MAY include secrets.*, github.*, hashFiles(...). Evaluated at run/job/step start; MUST NOT leak secrets into logs.

---

## Goals

1. Pipeline-as-config: YAML/JSON with name, on, env, jobs (runs-on, needs, steps); GHA/CircleCI-familiar.
2. Runners execute steps in process or container; support default, hostfn-runner, and self-hosted runners.
3. Integrate hostfn (deploy step), testfn (test step), flowfn (queue, DAG, cron), logfn/watchfn (observability), secfn (secrets), filefn (artifacts), plugfn (webhooks).
4. Self-deployable: control plane + runners deployable via hostfn or Docker/K8s; no required commercial CI.
5. Triggers: push/pull_request via plugfn webhooks, schedule via flowfn cron, workflow_dispatch via API.
6. CLI: cifn run, cifn status, cifn logs (local or remote).
7. Config in repo: pipeline in .ci/pipeline.yml or cifn.yml (configurable path); no pipeline stored only in vendor UI.
8. Dashboard for run history and logs (uifn/docsfn style).
9. Optional sendfn notifications on run/job failure or success.

## Non-goals

- MVP or mini subset; all listed features are in scope; priority (P0/P1/P2) only for phasing.
- Full GitHub Actions marketplace parity (reuse plugfn for integrations).
- Native Kubernetes job execution (v1: process/container on VMs).
- Built-in SaaS (self-hosted first).

---

## Public API

### Control plane HTTP API

Base path: `/api/v1`. All responses MUST use the canonical envelope.

**POST /runs**
- Body: `{ pipelineRef: { repo, ref, configPath? }, trigger: { type: "webhook"|"schedule"|"workflow_dispatch", payload?: object } }`.
- Response (201): `{ ok: true, data: { runId: string, status: "queued", createdAt: string (ISO 8601) } }`.
- Errors: 400 (invalid body), 422 (pipeline fetch/parse failed), 500 (server error). Code: `RUN_CREATE_FAILED`, `PIPELINE_INVALID`.

**GET /runs**
- Query: `limit` (default 20, max 100), `cursor?`, `status?` (queued|running|success|failure|cancelled).
- Response (200): `{ ok: true, data: { runs: Run[], nextCursor?: string } }`. Run: `{ runId, pipelineRef, trigger, status, createdAt, updatedAt, jobs?: JobSummary[] }`.

**GET /runs/:runId**
- Response (200): `{ ok: true, data: Run }` with full job/step tree. 404 if not found. Code: `RUN_NOT_FOUND`.

**POST /runs/:runId/cancel**
- Response (200): `{ ok: true, data: { runId, status: "cancelled" } }`. 404, 409 if already completed. Code: `RUN_NOT_FOUND`, `RUN_ALREADY_FINISHED`.

**GET /runs/:runId/jobs/:jobKey/logs**
- Response (200): stream or JSON array of log lines; Content-Type as specified. 404 if run or job not found.

**GET /runs/:runId/artifacts**
- Response (200): `{ ok: true, data: { artifacts: { name: string, fileId?: string, url?: string }[] } }`. Download URL from filefn when applicable.

**Runner registration (pull model)**
- **POST /runners/register**: Body `{ token: string, labels?: string[] }`. Token validated via secfn. Response: `{ ok: true, data: { runnerId: string } }`. Errors: 401 `RUNNER_TOKEN_INVALID`.
- **POST /runners/heartbeat**: Runner sends `{ runnerId: string }`; control plane returns next job or 204. Auth: runner-scoped secret.

### CLI

- **cifn run [--config path] [--trigger type]**  
  Parses local pipeline (default config path from env or .ci/pipeline.yml / cifn.yml), creates run via API (or runs locally if --local). Exit 0 on success, non-zero on failure. MUST NOT print secrets.

- **cifn status [runId]**  
  If runId omitted: list recent runs (calls GET /runs). If runId: show run detail (GET /runs/:runId). Output: machine-readable (JSON) or human-readable per --format.

- **cifn logs &lt;runId&gt; [jobKey]**  
  Fetches logs for run (and optional job). Streams or prints. MUST NOT emit secret values.

### Pipeline config schema (summary)

- **name**: string, optional.
- **on**: object; keys push, pull_request, schedule, workflow_dispatch; each with defined shape (e.g. push.branches: string[]).
- **env**: object (string → string), optional.
- **jobs**: object; key = jobKey; value: runs-on (string), needs (string[]), if (string, expression), env (object), steps (array).
- **steps[]**: each step: either `run: string` or `uses: string` with optional `with: object`, `if: string`. Allowed uses: checkout, cache/restore, cache/save, artifact/upload, artifact/download, testfn/run, hostfn/deploy.

Full schema MUST be defined in JSON Schema in schemas/pipeline.schema.json.

---

## Data formats / protocol

### Request envelope (API)

- No envelope for request body; Content-Type: application/json for JSON bodies.
- Query params as specified per endpoint.

### Response envelope (canonical)

```json
{ "ok": true, "data": <T> }
```
or
```json
{ "ok": false, "error": { "code": "<CIFN_CODE>", "message": "<human string>", "details": {} } }
```

HTTP status: 200/201 for ok:true; 4xx/5xx for ok:false. Body MUST always be JSON.

### Error codes

| code | HTTP | Meaning |
|------|------|---------|
| RUN_NOT_FOUND | 404 | runId does not exist |
| RUN_ALREADY_FINISHED | 409 | Cancel requested but run already completed |
| RUN_CREATE_FAILED | 422 | Run creation failed (e.g. pipeline invalid) |
| PIPELINE_INVALID | 422 | Pipeline parse or validation failed |
| RUNNER_TOKEN_INVALID | 401 | Runner registration token invalid or expired |
| BAD_REQUEST | 400 | Malformed body or query |
| INTERNAL_ERROR | 500 | Unspecified server error |

### Run state

- **status**: queued | running | success | failure | cancelled.
- **running**: at least one job running; **success**: all jobs success; **failure**: at least one job failed; **cancelled**: user or system cancelled.
- Job status: pending | running | success | failure | skipped. Step status: pending | running | success | failure | skipped.

### Determinism

- Job execution order MUST be deterministic given the same PipelineSpec and trigger (DAG from needs).
- Step order within a job MUST be the order defined in config.
- runId, jobId, stepId generation MAY be UUID or time-based; MUST be unique per run/job/step.
- Log content and artifact content MAY vary (timestamps, build outputs). Expression evaluation for `if` and env MUST be deterministic for same inputs (no randomness unless explicitly specified).

---

## Semantics

- **Create run**: Validate trigger; fetch pipeline from repo+ref (or use provided spec); parse and validate pipeline; create Run record with status queued; enqueue root jobs (no needs or needs satisfied) to flowfn; return runId.
- **Job execution**: Runner claims job from queue; updates job status to running; for each step: evaluate `if`; if true run step, else skip; on step failure, mark job failed and optionally fail dependent jobs; report logs to logfn; on job success, enqueue jobs that have all needs satisfied.
- **Artifacts**: Upload step writes workspace path to filefn under run-scoped namespace; returns artifact name. Download step reads artifact by name into workspace. Names are run-scoped.
- **Secrets**: Injected into job env from secfn at job start; keys requested by pipeline (e.g. secrets.HOSTFN_SSH_KEY). MUST NOT appear in logs or in response bodies.
- **Paging**: GET /runs uses limit + cursor; nextCursor present when more results exist. Order: createdAt descending.

---

## Invariants

- A run MUST NOT transition from success/failure/cancelled to any other status.
- A job MUST NOT start until all jobs in `needs` have completed successfully (or are skipped).
- A step MUST NOT run if its `if` expression evaluates to false.
- No step MUST receive secrets in plaintext in logs or in API responses.
- Pipeline config path MUST resolve to a single file; config path is configurable (default .ci/pipeline.yml or cifn.yml).
- Runner MUST only execute steps defined by the control plane for the claimed job; MUST NOT execute arbitrary remote code beyond step types.

---

## Security

- **Authn**: API: API key or bearer token (from secfn). Runners: registration token then runner-scoped secret for heartbeat/job fetch.
- **Authz**: Single-tenant by default; run/job access by runId. No cross-tenant visibility.
- **Secrets**: Stored and retrieved only via secfn; injected into runner env; MUST NOT be logged, persisted in control plane DB in plaintext, or returned in API.
- **Webhooks**: Incoming webhook payload MUST be verified (signature or plugfn validation) before creating a run.
- **Validation**: Pipeline MUST be validated against JSON Schema; invalid steps (unknown uses, invalid with) MUST be rejected at parse time.

---

## Limits/caps

- Pipeline document size: 500 KB max.
- jobs per pipeline: 100 max.
- steps per job: 100 max.
- needs depth (DAG): 10 max.
- GET /runs limit: 100 per request.
- Expression length (single expression): 2 KB max.
- Artifact name length: 256 chars. Artifact size: bounded by filefn limits.
- Cache key length: 1 KB. Cache entry size: bounded by cachefn/filefn.

---

## Observability

- **MUST log** (to logfn or equivalent): run created, run status change, job started/completed, step started/completed, runner registered/heartbeat, pipeline parse errors, API errors (with code, no secrets).
- **MUST NOT log**: secret values, full request bodies that may contain secrets, runner tokens in plaintext.
- **MAY emit** to watchfn: run duration, job duration, step duration, failure counts, queue depth. Metrics MUST NOT include PII or secrets.
- **Dashboard**: Run list, run detail (jobs, steps, logs), artifact list. Data from control plane API; auth same as API.

---

## Compatibility / versioning

- API version in path: /api/v1. Breaking changes require new version path.
- Pipeline schema version: version field in schema or config optional; v1 implied. New optional fields MUST be backward compatible; new required fields require schema version bump.
- CLI: backward compatible with at least one previous minor version of control plane API.

---

## Undefined / Explicitly user-deferred only

- **Full GitHub Actions marketplace parity**: Not in scope; use plugfn for external integrations.
- **Native Kubernetes job execution**: Deferred; v1 is process/container on VMs.
- **Built-in SaaS offering**: Deferred; self-hosted first.
- **Offline execution** of queued jobs without network: Undefined.
- **Python SDK**: Optional; not required for spec completeness; MAY be added in a later phase.
