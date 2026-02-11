# CiFn Audit-Fix Specification

## Metadata

- **timestamp**: 2026-02-07T17:17:04Z (UTC)
- **agent_name**: unknown-agent
- **model**: GPT-5.2 (exact version string not provided by runtime)
- **launcher**: Cursor
- **workspace/project absolute path**: /Users/ar/dev/superfunctions/cifn
- **OS + shell**: darwin 25.0.0, zsh
- **repo metadata**:
  - **git repo**: yes (superfunctions monorepo)
  - **repo root**: /Users/ar/dev/superfunctions
  - **branch**: heads/next
  - **commit**: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - **dirty status**: dirty (many changes; not all scoped to `cifn/`)
- **spec_folder**: 2026-02-07-audit-fix-k9m2p7xq-spec
- **spec_folder full path**: /Users/ar/dev/superfunctions/cifn/.conduct/specs/2026-02-07-audit-fix-k9m2p7xq-spec
- **spec_type**: audit-fix
- **spec_id**: k9m2p7xq
- **input paths (authoritative intent / notes)**:
  - /Users/ar/dev/superfunctions/cifn/SPEC.md
  - /Users/ar/dev/agent/intent/super functions/superfunctions-ar-notes.md
- **input paths (audit report; fixes in scope)**:
  - /Users/ar/dev/superfunctions/cifn/.conduct/audits/2026-02-07-r8c2m4p9-full-audit.md
- **related prior spec bundle**:
  - /Users/ar/dev/superfunctions/cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec

---

## Overview

CiFn is a **self-hosted CI/CD** system for the superfunctions ecosystem. It runs repository-defined pipelines (build → test → deploy) on infrastructure the user controls, using:

- **flowfn** for queues / orchestration / scheduling
- **filefn** for artifacts (and optionally cache)
- **secfn** for secrets and tokens
- **logfn** (and optionally **watchfn**) for observability
- **plugfn** for webhook + repo access integrations (GitHub/GitLab)
- **testfn** for test execution
- **hostfn** for deployments
- **sendfn** for optional notifications

This spec is an **audit-fix**: it defines the precise target behavior needed to fix every issue identified in the referenced audit report, while remaining fully aligned with authoritative intent.

### Context (filled from intent + audit)

- **Project name**: CiFn
- **One-sentence goal**: Self-hosted CI/CD (like CircleCI/GitHub Actions) that integrates with superfunctions and is self-deployable.
- **Target users**: Teams using superfunctions (hostfn/flowfn/testfn/etc.) who want CI/CD on their own infra.
- **Target environments**:
  - Control plane: Node.js server (Linux recommended; macOS acceptable for dev)
  - Runner: Node.js process and/or Docker-based execution on Linux (macOS acceptable for dev)
  - CLI: Node.js on developer machines
  - Dashboard: SPA in a browser, talking to control plane HTTP API
- **Languages/packages required**: TypeScript (primary). JSON Schema (Ajv2020). YAML parser. Hono (HTTP). Vitest (tests).
- **Existing systems it must integrate with**: hostfn, testfn, flowfn, filefn, secfn, logfn, plugfn (sendfn/watchfn optional).
- **Data model summary**:
  - PipelineSpec (parsed/validated pipeline)
  - Run → Job → Step hierarchy
  - Runner registration + labels + auth secret
  - Artifacts (named, run-scoped)
  - Cache entries (keyed, optional)
- **Security model**:
  - API authentication via API key/Bearer token (source of truth: secfn)
  - Runner registration token (secfn) + **runner-scoped secret** thereafter
  - Webhook signature verification (HMAC or plugfn verifier)
  - Secret injection from secfn; redaction in logs and API responses
  - Single-tenant by default (no per-user/per-project RBAC in v1)
- **Performance constraints** (best-effort; not strict SLAs):
  - Pipeline parse + validate: < 500ms for configs ≤ 500KB on a typical dev server
  - Dispatch-to-runner when runner available: < 5s p99
  - Run listing: paging with limit ≤ 100
- **Non-goals / out of scope**:
  - Full GitHub Actions marketplace parity
  - Kubernetes-native execution (v1)
  - CiFn as a hosted SaaS
- **Hard constraints**:
  - Pipeline config MUST be validated against a declared JSON Schema.
  - Secrets MUST NOT appear in logs, dashboard, CLI output, or API responses.
  - Job/step execution order MUST be deterministic for the same inputs.

---

## Glossary

- **Pipeline**: A single YAML/JSON document defining `name`, `on`, optional `env`, and `jobs`.
- **PipelineRef**: A reference to a pipeline config stored in a Git repo at a ref/commit: `{ repo, ref, configPath? }`.
- **PipelineSpec**: The parsed/validated canonical pipeline object used for execution.
- **Run**: One execution of a pipeline triggered by a `Trigger` event. Identified by `runId`.
- **Job**: A named node in the pipeline DAG (`jobs.<jobKey>`). Identified by `(runId, jobKey)`.
- **Step**: A unit of work in a job. Either `run` or `uses` (action).
- **Runner**: An agent that polls/claims jobs and executes steps.
- **Envelope**: Canonical API response shape: `{ ok: true, data: T }` or `{ ok: false, error: { code, message, details? } }`.
- **Expression**: `${{ ... }}` or raw `if` condition text; evaluated deterministically at run/job/step boundaries.
- **Secret**: Value sourced from secfn and injected into env/with; MUST be redacted from logs.

---

## Goals

CiFn MUST:

1. Support **pipeline-as-config** (YAML/JSON) with GHA/CircleCI-familiar shape.
2. Support triggers: **push**, **pull_request**, **schedule (cron)**, **workflow_dispatch**.
3. Execute jobs in a **DAG** based on `needs`, with deterministic ordering.
4. Provide a control-plane HTTP API for run creation, listing, detail, cancel, logs, artifacts, runner registration/heartbeat.
5. Provide runners that execute steps in a workspace as **processes** and/or within **Docker** images.
6. Support step types: `run`, `checkout`, `cache/restore`, `cache/save`, `artifact/upload`, `artifact/download`, `testfn/run`, `hostfn/deploy`.
7. Implement `if` semantics and expression evaluation (`github.*`, `secrets.*`, `hashFiles(...)`, `failure()` and related functions).
8. Integrate with superfunctions ecosystem components (flowfn/filefn/secfn/logfn/plugfn/testfn/hostfn).
9. Be **self-deployable** (ship runnable deployment artifacts).
10. Provide CLI and dashboard that are compatible with the control-plane API contract.

### Hybrid usage patterns (optional)

CiFn MAY be adopted incrementally by using an external CI system (e.g. GitHub Actions) as the trigger surface while CiFn performs execution on self-hosted runners:

- External CI triggers CiFn by calling `POST /api/v1/runs` (usually with `pipelineRef`).
- CiFn executes the pipeline, stores run history, and exposes logs/artifacts via its API/dashboard.

---

## Non-goals

- Full parity with GitHub Actions marketplace/actions.
- Kubernetes job execution (v1).
- Multi-tenant authz / RBAC (v1).

---

## Public API

### HTTP API (control plane)

Base path: `/api/v1`. All responses MUST be JSON and MUST use the **Envelope** (no bare responses), **except** for endpoints explicitly defined otherwise (none in this spec).

#### POST `/runs` (create run)

Request body MUST be one of:

1) **Repo-backed**:

```json
{
  "pipelineRef": { "repo": "https://github.com/org/repo", "ref": "main", "configPath": ".ci/pipeline.yml" },
  "trigger": { "type": "push" | "pull_request" | "schedule" | "workflow_dispatch", "payload": {} }
}
```

2) **Inline** (allowed for dev/test and for API-driven pipelines):

```json
{
  "pipelineSpec": { "name": "x", "on": { "workflow_dispatch": {} }, "jobs": { "...": {} } },
  "trigger": { "type": "workflow_dispatch", "payload": {} }
}
```

Rules:
- The server MUST accept **either** `pipelineRef` or `pipelineSpec`.
- The server MUST reject requests containing **neither** with `BAD_REQUEST`.
- If both are provided, the server MUST use `pipelineSpec` and MUST ignore `pipelineRef` (and SHOULD include a warning in `details` only when returning an error).

Success response:

```json
{ "ok": true, "data": { "runId": "r_...", "status": "queued", "createdAt": "2026-02-07T17:17:04Z" } }
```

Errors:
- `BAD_REQUEST` (400): invalid JSON, missing required fields, invalid query types.
- `PIPELINE_INVALID` (422): pipeline parse/validate fails.
- `RUN_CREATE_FAILED` (422): pipelineRef fetch fails; repo/ref/configPath cannot be resolved; other creation failures.
- `UNAUTHORIZED` (401): missing/invalid API auth.

#### GET `/runs` (list runs)

Query:
- `limit`: integer, default 20, max 100
- `cursor`: optional opaque cursor string
- `status`: optional (`queued|running|success|failure|cancelled`)

Response:

```json
{ "ok": true, "data": { "runs": [ { "runId": "...", "status": "queued", "createdAt": "...", "updatedAt": "..." } ], "nextCursor": "..." } }
```

Rules:
- Results MUST be ordered by `createdAt` descending.
- Invalid `cursor` MUST return `BAD_REQUEST` (not an empty list).

#### GET `/runs/:runId` (run detail)

Response MUST include the canonical identifiers:
- Run uses `runId` (NOT `id`)
- Job uses `jobKey` (the YAML key)
- Step uses `stepIndex` (array index) AND a stable `stepKey` derived deterministically (see Determinism)

#### POST `/runs/:runId/cancel` (cancel run)

- Cancels queued/running runs.
- MUST be idempotent for already-cancelled runs.
- MUST return `RUN_ALREADY_FINISHED` (409) when run is success/failure.

#### GET `/runs/:runId/jobs/:jobKey/logs`

Response shape (example):

```json
{ "ok": true, "data": { "runId": "...", "jobKey": "build", "lines": ["..."], "truncated": false } }
```

Rules:
- Logs MUST NOT include secret values.
- Logs MAY be truncated; if so, `truncated: true` MUST be set and a `nextCursor` MAY be provided.

#### GET `/runs/:runId/artifacts`

Response:

```json
{ "ok": true, "data": { "artifacts": [ { "name": "dist", "fileId": "f_...", "url": "https://..." } ] } }
```

Rules:
- Artifacts are scoped to `runId`.
- `url` MUST be a time-limited download URL when available; `fileId` MUST be present when the artifact is stored in filefn.

#### POST `/runners/register`

Request:

```json
{ "token": "runner-registration-token", "labels": ["default"] }
```

Response MUST include a **runner-scoped secret** returned only once:

```json
{ "ok": true, "data": { "runnerId": "runner_...", "runnerSecret": "rs_..." } }
```

Rules:
- `token` MUST be validated against secfn.
- The control plane MUST store only a **hash** of `runnerSecret` (never plaintext).

Errors:
- `RUNNER_TOKEN_INVALID` (401): invalid registration token.

#### POST `/runners/heartbeat`

Auth:
- MUST be `Authorization: Bearer <runnerSecret>` (runner-scoped secret).

Request:

```json
{ "runnerId": "runner_..." }
```

Response when job available:

```json
{ "ok": true, "data": { "job": { "runId": "...", "jobKey": "...", "pipeline": { ... }, "context": { ... } } } }
```

Response when no job:

```json
{ "ok": true, "data": { "job": null } }
```

Errors:
- `UNAUTHORIZED` (401): missing/invalid runnerSecret or runnerId mismatch.
- `RUNNER_NOT_FOUND` (404): runnerId unknown (only if runnerSecret is valid but runnerId not found; otherwise `UNAUTHORIZED`).

### Webhook API (triggers)

CiFn MUST expose webhook endpoints for repo providers. The canonical GitHub-style endpoint is:

- `POST /webhooks/github`

Rules:
- The endpoint MUST verify the webhook signature (HMAC SHA-256) OR delegate verification to plugfn.
- On success, it MUST create a run using `pipelineRef` (repo URL + ref) and trigger payload.

### CLI

The CLI MUST provide:

- `cifn run`:
  - Remote mode (default): create a run in the control plane.
  - Local mode (`--local`): execute pipeline locally using the same runner engine (no control plane required).
- `cifn status`:
  - list runs or show run detail
- `cifn logs`:
  - fetch and print logs

### Dashboard

The dashboard MUST be compatible with the API contract and MUST treat the run identifier as `runId` (not `id`).

---

## Data formats / protocol

### Canonical response envelope

Success:

```json
{ "ok": true, "data": {} }
```

Error:

```json
{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "…", "details": {} } }
```

### Error codes

The set below is the canonical set for v1:

| code | HTTP | Meaning |
|------|------|---------|
| BAD_REQUEST | 400 | malformed JSON / invalid params |
| UNAUTHORIZED | 401 | missing/invalid API key or runnerSecret |
| RUNNER_TOKEN_INVALID | 401 | invalid runner registration token |
| PIPELINE_INVALID | 422 | pipeline parse/validate failed |
| RUN_CREATE_FAILED | 422 | pipelineRef fetch failed / creation failure |
| RUN_NOT_FOUND | 404 | runId does not exist |
| RUN_ALREADY_FINISHED | 409 | cancel called on terminal run |
| RUNNER_NOT_FOUND | 404 | runnerId does not exist |
| INTERNAL_ERROR | 500 | server error |

---

## Semantics

### Pipeline resolution (pipelineRef)

When a run is created using `pipelineRef`, the control plane MUST:

1. Resolve `repo` + `ref` to a checkout (via git clone) OR fetch file contents via plugfn provider APIs.
2. Resolve `configPath`:
   - If provided: MUST use it.
   - If omitted: MUST try `.ci/pipeline.yml`, then `.ci/pipeline.yaml`, then `cifn.yml`, then `cifn.yaml` (first that exists).
3. Parse YAML/JSON and validate against schema.
4. Store the canonical PipelineSpec (or its hash + provenance).

### Job DAG execution

- Jobs form a DAG via `needs`.
- A job MUST NOT start until all jobs in `needs` are in status `success` or `skipped`.
- If any job in `needs` is `failure` or `cancelled`, dependent jobs MUST be marked `skipped` (reason: dependency failed/cancelled).

### `if` semantics (jobs and steps)

#### Expressions

- `if` is a boolean expression string.
- Expressions MUST be evaluated deterministically.
- Maximum `if` string length MUST be 2048 characters.

Supported symbols (v1):
- `github.ref` (string)
- `github.repository` (string)
- `github.sha` (string)
- `github.event_name` (string; push|pull_request|schedule|workflow_dispatch)
- `secrets.<NAME>` (string; only resolvable if secret is available; MUST be treated as secret material)

Supported operators (v1):
- equality: `==`, `!=`
- boolean: `&&`, `||`, `!`
- parentheses: `(`, `)`

Supported functions (v1):
- `success()`: true iff no prior step in the same job has failed
- `failure()`: true iff any prior step in the same job has failed
- `always()`: always true

#### Default step condition

- If a step does not specify `if`, its effective condition MUST be `success()`.

#### Step failure propagation

- When a step fails, the job’s final status MUST be `failure`.
- After a step fails, the runner MUST continue evaluating subsequent steps:
  - Steps whose effective condition evaluates to true MUST run (e.g., `if: failure()` or `if: always()`).
  - Steps whose effective condition is false MUST be marked `skipped`.

#### Job `if`

- If a job has an `if` and it evaluates to false, the job MUST be marked `skipped` and MUST NOT execute any steps.
- A skipped job MUST satisfy `needs` for dependent jobs.

### `${{ ... }}` interpolation

Interpolation MAY appear in:
- job `env` values
- step `with` values
- step `run` strings (string interpolation before shell execution)
- cache keys

Supported interpolations (v1):
- `${{ github.* }}` (as above)
- `${{ secrets.* }}` (as above)
- `${{ hashFiles('<glob>') }}`:
  - Computes a deterministic hash of the contents of all matching files in the job workspace.
  - MUST return a lowercase hex string.
  - If no files match, MUST return the hash of the empty string.

### Step semantics

CiFn step actions MUST have well-defined `with` shapes and semantics:

- `uses: checkout`
  - Clones repo at trigger ref into workspace.
  - MUST support private repo auth (token sourced from secfn/plugfn).
  - MUST NOT log a clone URL containing credentials.
- `uses: cache/restore`
  - Restores paths from cache if key hit.
- `uses: cache/save`
  - Saves paths to cache under key.
- `uses: artifact/upload`
  - Uploads file/directory to filefn under run-scoped namespace.
- `uses: artifact/download`
  - Downloads named artifact into workspace.
- `uses: testfn/run`
  - MUST use the **testfn SDK** (e.g. `@testfn/core`) and its adapters/reporters.
- `uses: hostfn/deploy`
  - MUST invoke hostfn deployment for environment, using secrets from secfn.

---

## Invariants

- **Secrets** MUST NOT appear in:
  - runner logs (stdout/stderr)
  - API responses
  - dashboard UI
  - CLI output
- **Determinism**:
  - Job ordering and step ordering MUST be deterministic for the same PipelineSpec + trigger payload.
  - `hashFiles` MUST be deterministic for the same workspace contents.
- **Terminal state immutability**:
  - Run MUST NOT transition out of `success|failure|cancelled`.
  - Job MUST NOT transition out of `success|failure|skipped`.
- **Schema enforcement**:
  - Unknown `uses` MUST be rejected at validation time.
  - Invalid `with` keys for known `uses` MUST be rejected at validation time.

---

## Security

- **API authn**: All `/api/v1/*` endpoints (except optional `/health`) MUST require an API key/Bearer token validated via secfn.
- **Runner authn**:
  - Registration uses a secfn-backed registration token.
  - Heartbeat uses a runner-scoped secret returned at registration (stored only hashed server-side).
- **Webhook verification**: Webhook triggers MUST verify signature before creating runs.
- **Secret injection**:
  - Secrets MUST be resolved from secfn at job start (or earlier) and injected only into the runner environment.
  - The control plane MUST NOT persist plaintext secret values.
- **Redaction**:
  - The runner MUST redact known secret values from captured stdout/stderr.
  - Checkout tokens (e.g. `with.token`) MUST be included in the redaction set.

---

## Limits / caps

CiFn MUST enforce the following caps (v1):

- Pipeline document size ≤ 500KB
- Jobs per pipeline ≤ 100
- Steps per job ≤ 100
- Needs depth ≤ 10
- List runs `limit` ≤ 100
- Expression length (`if` or `${{ ... }}`) ≤ 2048 chars
- Artifact name length ≤ 256 chars
- Cache key length ≤ 1024 chars

---

## Observability

CiFn MUST emit structured logs via logfn (library and/or service integration):

Required events (at minimum):
- `run.created`
- `run.status_changed`
- `job.started`, `job.completed`
- `step.started`, `step.completed`
- `runner.registered`, `runner.heartbeat`
- `webhook.verified`, `webhook.rejected`

Rules:
- Logs MUST be structured (JSON event) with stable fields.
- Logs MUST be redacted before emitting.
- The API logs endpoint MUST be backed by stored log lines/events for a job, with redaction applied.

watchfn metrics MAY be emitted (optional).

---

## Compatibility / versioning strategy

- HTTP API is versioned via path prefix (`/api/v1`).
- Pipeline schema is implicitly v1; the parser MUST normalize:
  - `on.schedule` MAY be provided as an object (`{cron: "…"}`) or an array (`[{cron:"…"}]`).
  - Canonical PipelineSpec MUST store schedule as an array of `{ cron: string }`.
- Dashboard and CLI MUST be compatible with the API contract for the same major version.

---

## Undefined / Explicitly user-deferred only

The following are intentionally Undefined for v1 (not required):

- Kubernetes-native job execution
- Multi-tenant isolation / RBAC / per-project authz
- Marketplace action import beyond the built-in `uses` allowlist
- Sandboxing beyond process isolation and optional Docker execution

