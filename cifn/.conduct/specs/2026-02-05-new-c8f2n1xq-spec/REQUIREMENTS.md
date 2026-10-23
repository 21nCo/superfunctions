# CiFn Requirements

## Table of contents

- [PIPE-001](#pipe-001) … [PIPE-010](#pipe-010) Pipeline and config
- [API-001](#api-001) … [API-010](#api-010) Control plane API
- [RUN-001](#run-001) … [RUN-008](#run-008) Runs, jobs, steps
- [RUNNER-001](#runner-001) … [RUNNER-006](#runner-006) Runners
- [SEC-001](#sec-001) … [SEC-005](#sec-005) Security
- [INT-001](#int-001) … [INT-006](#int-006) Integrations (flowfn, filefn, secfn, logfn, hostfn, testfn)
- [CLI-001](#cli-001) … [CLI-004](#cli-004) CLI
- [OBS-001](#obs-001) … [OBS-003](#obs-003) Observability
- [LIMIT-001](#limit-001) … [LIMIT-003](#limit-003) Limits

---

## Pipeline and config

### PIPE-001
- **Priority**: P0
- **Statement**: The system MUST accept pipeline config as YAML or JSON with name, on, env, and jobs (each job: runs-on, needs, if, env, steps).
- **Rationale**: Pipeline-as-config is a core goal; GHA/CircleCI-familiar shape.
- **Acceptance criteria**:
  - Valid YAML and JSON pipeline documents are accepted and produce a PipelineSpec.
  - PipelineSpec includes resolved job DAG from needs.
- **Test vectors**: TV-PIPE-001, TV-PIPE-002
- **Notes**: configPath default .ci/pipeline.yml or cifn.yml.

### PIPE-002
- **Priority**: P0
- **Statement**: The system MUST validate pipeline config against a declared JSON Schema (schemas/pipeline.schema.json).
- **Rationale**: Hard constraint; invalid config MUST be rejected before execution.
- **Acceptance criteria**:
  - Valid config passes validation.
  - Invalid config (missing required, unknown top-level key that is required to be known, invalid step type) fails with defined error.
- **Test vectors**: TV-PIPE-003, TV-PIPE-004
- **Notes**: Schema MUST define on, env, jobs, steps, allowed uses.

### PIPE-003
- **Priority**: P0
- **Statement**: Supported step types MUST include: run (shell), uses: checkout, cache/restore, cache/save, artifact/upload, artifact/download, testfn/run, hostfn/deploy.
- **Rationale**: Full intent from source spec.
- **Acceptance criteria**:
  - Parser accepts each step type; unknown uses MUST be rejected at parse/validation.
- **Test vectors**: TV-PIPE-005, TV-PIPE-006
- **Notes**: Step params (with) per step type defined in schema.

### PIPE-004
- **Priority**: P0
- **Statement**: Triggers (on) MUST support push (branches), pull_request (branches), schedule (cron), workflow_dispatch.
- **Rationale**: Intent: webhook, cron, manual trigger.
- **Acceptance criteria**:
  - Pipeline with each trigger type parses; trigger is used to start runs (push/pull_request via webhook, schedule via flowfn, workflow_dispatch via API).
- **Test vectors**: TV-PIPE-007
- **Notes**: Exact shape of on in schema.

### PIPE-005
- **Priority**: P1
- **Statement**: The system MUST support expressions in config (e.g. ${{ secrets.* }}, ${{ github.ref }}, hashFiles(...)) for if, env, and step with; expressions MUST be evaluated at run/job/step start and MUST NOT leak secrets into logs.
- **Rationale**: Intent: conditional steps and secret injection.
- **Acceptance criteria**:
  - Expression in if skips step when false; env and with get evaluated values.
  - secrets.* values never appear in log output or API response.
- **Test vectors**: TV-PIPE-008, TV-PIPE-009
- **Notes**: Expression length cap 2 KB.

### PIPE-006
- **Priority**: P1
- **Statement**: Config file path MUST be configurable; default MUST be .ci/pipeline.yml or cifn.yml.
- **Rationale**: Config in repo; path flexibility.
- **Acceptance criteria**:
  - CLI and API accept configPath; when omitted, default is applied.
- **Test vectors**: TV-PIPE-010
- **Notes**: Single file per pipeline.

### PIPE-007
- **Priority**: P0
- **Statement**: Jobs MUST form a DAG via needs; execution order MUST respect the DAG (a job MUST NOT start until all jobs in needs have completed successfully or are skipped).
- **Rationale**: Intent: job dependencies and artifact passing.
- **Acceptance criteria**:
  - Run with needs: [build] for test job: test starts only after build succeeds (or is skipped).
  - Cyclic needs MUST be rejected at validation.
- **Test vectors**: TV-RUN-002, TV-RUN-003
- **Notes**: needs depth cap 10.

### PIPE-008
- **Priority**: P0
- **Statement**: runs-on MUST support at least: default, hostfn-runner; MAY support labels (e.g. docker-ubuntu-22). Runner selection MUST match runs-on.
- **Rationale**: Intent: default runner, hostfn-runner for deploy.
- **Acceptance criteria**:
  - Job with runs-on: default is dispatched to a default runner; runs-on: hostfn-runner to hostfn-runner when available.
- **Test vectors**: TV-RUNNER-001
- **Notes**: Self-hosted runners have labels.

### PIPE-009
- **Priority**: P1
- **Statement**: Step condition if MUST be supported; when if expression evaluates to false, the step MUST be skipped (status skipped).
- **Rationale**: Intent: conditional upload (e.g. on failure), branch-based deploy.
- **Acceptance criteria**:
  - Step with if: failure() runs only when previous step failed; step with if: github.ref == 'refs/heads/main' evaluates at run start.
- **Test vectors**: TV-PIPE-008
- **Notes**: Expression semantics in glossary.

### PIPE-010
- **Priority**: P0
- **Statement**: Pipeline document size MUST NOT exceed 500 KB; jobs per pipeline max 100; steps per job max 100; needs depth max 10.
- **Rationale**: Limits/caps from spec.
- **Acceptance criteria**:
  - Oversized document or counts above limit fail validation with defined error.
- **Test vectors**: TV-LIMIT-001, TV-LIMIT-002
- **Notes**: See LIMIT-001.

---

## Control plane API

### API-001
- **Priority**: P0
- **Statement**: All API responses MUST use the canonical envelope: { ok: true, data: T } or { ok: false, error: { code, message, details? } }; HTTP status 200/201 for ok:true, 4xx/5xx for ok:false.
- **Rationale**: Consistent protocol for clients.
- **Acceptance criteria**:
  - Every documented endpoint returns JSON with ok and either data or error; no bare body.
- **Test vectors**: TV-API-001, TV-API-002
- **Notes**: Content-Type application/json.

### API-002
- **Priority**: P0
- **Statement**: POST /api/v1/runs MUST accept body { pipelineRef: { repo, ref, configPath? }, trigger: { type, payload? } } and MUST return 201 with { ok: true, data: { runId, status: "queued", createdAt } } or 422 with RUN_CREATE_FAILED / PIPELINE_INVALID.
- **Rationale**: Create run is primary mutation.
- **Acceptance criteria**:
  - Valid body creates run and returns runId; invalid body returns 400; pipeline fetch/parse failure returns 422 with code.
- **Test vectors**: TV-API-003, TV-API-004, TV-API-005
- **Notes**: repo/ref identify pipeline source.

### API-003
- **Priority**: P0
- **Statement**: GET /api/v1/runs MUST accept limit (default 20, max 100) and optional cursor, status; MUST return { ok: true, data: { runs, nextCursor? } }; runs ordered by createdAt descending.
- **Rationale**: List runs with paging.
- **Acceptance criteria**:
  - Response contains runs array; nextCursor present when more results exist; status filter applied when provided.
- **Test vectors**: TV-API-006, TV-API-007
- **Notes**: Paging semantics.

### API-004
- **Priority**: P0
- **Statement**: GET /api/v1/runs/:runId MUST return 200 with full Run (jobs, steps) or 404 with RUN_NOT_FOUND.
- **Rationale**: Run detail for status and dashboard.
- **Acceptance criteria**:
  - Existing runId returns run; non-existent returns 404 and error code RUN_NOT_FOUND.
- **Test vectors**: TV-API-008, TV-API-009
- **Notes**: No secrets in response.

### API-005
- **Priority**: P0
- **Statement**: POST /api/v1/runs/:runId/cancel MUST set run status to cancelled and return 200, or 404 RUN_NOT_FOUND / 409 RUN_ALREADY_FINISHED if run already completed.
- **Rationale**: User cancellation.
- **Acceptance criteria**:
  - Queued or running run becomes cancelled; already success/failure/cancelled returns 409.
- **Test vectors**: TV-API-010, TV-API-011
- **Notes**: Idempotent for already cancelled.

### API-006
- **Priority**: P1
- **Statement**: GET /api/v1/runs/:runId/jobs/:jobKey/logs MUST return log content for the job (stream or JSON); 404 if run or job not found.
- **Rationale**: CLI cifn logs and dashboard.
- **Acceptance criteria**:
  - Valid runId and jobKey return logs; MUST NOT include secret values.
- **Test vectors**: TV-API-012, TV-API-013
- **Notes**: Logs from logfn.

### API-007
- **Priority**: P1
- **Statement**: GET /api/v1/runs/:runId/artifacts MUST return { ok: true, data: { artifacts: { name, fileId?, url? }[] } }; download URL from filefn when applicable.
- **Rationale**: Artifact list for run.
- **Acceptance criteria**:
  - Response lists artifact names produced by upload steps; url or fileId for download.
- **Test vectors**: TV-API-014
- **Notes**: Run-scoped artifacts.

### API-008
- **Priority**: P0
- **Statement**: The control plane MUST authenticate API callers (API key or bearer token from secfn) for all /api/v1/* endpoints except health; unauthenticated requests MUST receive 401.
- **Rationale**: Security model.
- **Acceptance criteria**:
  - Request without valid token returns 401; valid token allows access per authz.
- **Test vectors**: TV-SEC-001, TV-SEC-002
- **Notes**: Health endpoint MAY be unauthenticated.

### API-009
- **Priority**: P0
- **Statement**: Error responses MUST use defined codes: RUN_NOT_FOUND, RUN_ALREADY_FINISHED, RUN_CREATE_FAILED, PIPELINE_INVALID, RUNNER_TOKEN_INVALID, BAD_REQUEST, INTERNAL_ERROR.
- **Rationale**: Canonical error handling.
- **Acceptance criteria**:
  - Each error path returns the specified code in error.code.
- **Test vectors**: TV-API-002, TV-API-004, TV-API-005, TV-API-009, TV-API-011
- **Notes**: See SPEC Data formats.

### API-010
- **Priority**: P1
- **Statement**: POST /api/v1/runners/register MUST accept { token, labels? }; validate token via secfn; return { ok: true, data: { runnerId } } or 401 RUNNER_TOKEN_INVALID. POST /api/v1/runners/heartbeat MUST accept { runnerId } with runner-scoped auth and return next job or 204.
- **Rationale**: Runner pull model.
- **Acceptance criteria**:
  - Valid token registers runner; invalid token returns 401. Heartbeat returns job when available.
- **Test vectors**: TV-RUNNER-002, TV-RUNNER-003
- **Notes**: Token from secfn.

---

## Runs, jobs, steps

### RUN-001
- **Priority**: P0
- **Statement**: A run MUST have status one of: queued, running, success, failure, cancelled. Run MUST NOT transition from success/failure/cancelled to any other status.
- **Rationale**: Invariant for consistency.
- **Acceptance criteria**:
  - State machine enforced; no backward transitions from terminal states.
- **Test vectors**: TV-RUN-001, TV-API-010
- **Notes**: running = at least one job running.

### RUN-002
- **Priority**: P0
- **Statement**: Job execution order MUST be deterministic given the same PipelineSpec and trigger; job MUST NOT start until all jobs in needs have completed successfully or are skipped.
- **Rationale**: DAG semantics.
- **Acceptance criteria**:
  - Same pipeline + same trigger produces same job order; job with needs waits for dependencies.
- **Test vectors**: TV-RUN-002, TV-RUN-003
- **Notes**: Determinism rule in spec.

### RUN-003
- **Priority**: P0
- **Statement**: Step order within a job MUST be the order defined in config; a step MUST NOT run if its if expression evaluates to false (step marked skipped).
- **Rationale**: Step semantics.
- **Acceptance criteria**:
  - Steps execute in array order; if false → skipped; no execution.
- **Test vectors**: TV-RUN-004, TV-PIPE-008
- **Notes**: Evaluation at step start.

### RUN-004
- **Priority**: P0
- **Statement**: runId, jobId, stepId MUST be unique per run/job/step respectively; generation MAY be UUID or time-based.
- **Rationale**: Uniqueness for storage and API.
- **Acceptance criteria**:
  - No duplicate runId in system; jobId unique within run; stepId unique within job.
- **Test vectors**: TV-RUN-005
- **Notes**: Idempotency of create run: same trigger may create new run (new runId).

### RUN-005
- **Priority**: P1
- **Statement**: Artifact upload step MUST write workspace path to filefn under run-scoped namespace; artifact name MUST be run-scoped. Download step MUST read artifact by name into workspace.
- **Rationale**: Artifacts via filefn.
- **Acceptance criteria**:
  - Upload produces artifact visible in GET /runs/:runId/artifacts; download step in later job places files in workspace.
- **Test vectors**: TV-INT-002
- **Notes**: filefn integration.

### RUN-006
- **Priority**: P1
- **Statement**: Cache restore/save steps MUST use cachefn or filefn-backed cache; key MAY contain expressions (e.g. hashFiles); paths for save MUST be supported.
- **Rationale**: Intent: cache steps.
- **Acceptance criteria**:
  - Restore populates workspace when cache hit; save stores paths under key; key expression evaluated.
- **Test vectors**: TV-INT-003
- **Notes**: cachefn or filefn.

### RUN-007
- **Priority**: P0
- **Statement**: Checkout step MUST clone repo at trigger ref (from pipelineRef or trigger payload); workspace MUST be the clone root for subsequent steps.
- **Rationale**: Intent: checkout step.
- **Acceptance criteria**:
  - After checkout, workspace contains repo at correct ref; clone via plugfn or git CLI.
- **Test vectors**: TV-INT-005
- **Notes**: Credentials from secfn if private repo.

### RUN-008
- **Priority**: P1
- **Statement**: testfn/run step MUST invoke testfn SDK in runner with config (e.g. vitest.config.ts) and reporter; hostfn/deploy step MUST call hostfn CLI with environment and --ci, env (e.g. HOSTFN_SSH_KEY) from secfn.
- **Rationale**: Intent: testfn and hostfn steps.
- **Acceptance criteria**:
  - testfn step runs tests and reports pass/fail; hostfn step runs hostfn deploy &lt;env&gt; --ci with injected secrets.
- **Test vectors**: TV-INT-004, TV-INT-006
- **Notes**: hostfn-runner for deploy can use --local --ci.

---

## Runners

### RUNNER-001
- **Priority**: P0
- **Statement**: The system MUST support default runner (single process or Docker per job) and hostfn-runner type; runner selection MUST match job runs-on.
- **Rationale**: Intent: default and hostfn-runner.
- **Acceptance criteria**:
  - Jobs with runs-on: default get dispatched to default runner; runs-on: hostfn-runner to hostfn-runner when available.
- **Test vectors**: TV-RUNNER-001
- **Notes**: Configurable image for default.

### RUNNER-002
- **Priority**: P0
- **Statement**: Runners MUST authenticate to control plane; registration via token from secfn; after registration, heartbeat MUST use runner-scoped secret.
- **Rationale**: Security: only authorized runners execute jobs.
- **Acceptance criteria**:
  - Invalid registration token returns 401; heartbeat without valid auth not accepted.
- **Test vectors**: TV-RUNNER-002, TV-RUNNER-003
- **Notes**: Pull model: runner polls or receives jobs.

### RUNNER-003
- **Priority**: P0
- **Statement**: Runner MUST only execute steps defined by the control plane for the claimed job; MUST NOT execute arbitrary remote code beyond declared step types (run, checkout, cache, artifact, testfn, hostfn).
- **Rationale**: Security invariant.
- **Acceptance criteria**:
  - Runner receives job payload with step list; executes only those steps; no remote code execution from untrusted source.
- **Test vectors**: TV-RUNNER-004
- **Notes**: Step types are fixed.

### RUNNER-004
- **Priority**: P1
- **Statement**: Self-hosted runners MUST be registerable with labels; control plane MUST dispatch jobs to runners whose labels match runs-on when runs-on is a label set.
- **Rationale**: Intent: self-hosted and optional cloud runners.
- **Acceptance criteria**:
  - Register with labels; job with runs-on: docker-ubuntu-22 goes to runner with that label when supported.
- **Test vectors**: TV-RUNNER-005
- **Notes**: v1 fixed set of runners.

### RUNNER-005
- **Priority**: P0
- **Statement**: Runner MUST report step logs to logfn and step/job status to control plane; control plane MUST persist run/job/step state.
- **Rationale**: Observability and API semantics.
- **Acceptance criteria**:
  - After step run, logs available via GET logs; job/run status updated.
- **Test vectors**: TV-OBS-001
- **Notes**: logfn integration.

### RUNNER-006
- **Priority**: P1
- **Statement**: hostfn-runner MUST execute on a hostfn-managed node; deploy step MAY use hostfn deploy --local --ci when on same node.
- **Rationale**: Intent: deploy without SSH when runner is on target.
- **Acceptance criteria**:
  - Job with runs-on: hostfn-runner and hostfn/deploy step can pass --local; deploy succeeds when runner is on target node.
- **Test vectors**: TV-RUNNER-006
- **Notes**: Optional; depends on hostfn.

---

## Security

### SEC-001
- **Priority**: P0
- **Statement**: Job secrets MUST be injected from secfn only; MUST NOT be logged, persisted in control plane in plaintext, or returned in API responses.
- **Rationale**: Security model.
- **Acceptance criteria**:
  - secrets.* in pipeline resolved via secfn at job start; no secret value in log output or GET response body.
- **Test vectors**: TV-SEC-003, TV-PIPE-009
- **Notes**: Expression evaluation redacts secrets.

### SEC-002
- **Priority**: P0
- **Statement**: Incoming webhook payload MUST be verified (signature or plugfn validation) before creating a run.
- **Rationale**: Prevent unauthorized run creation.
- **Acceptance criteria**:
  - Unverified webhook does not create run (401 or 403); verified webhook creates run when pipeline valid.
- **Test vectors**: TV-SEC-004
- **Notes**: plugfn or HMAC.

### SEC-003
- **Priority**: P0
- **Statement**: Pipeline MUST be validated against JSON Schema; invalid steps (unknown uses, invalid with) MUST be rejected at parse/validation with PIPELINE_INVALID.
- **Rationale**: No execution of invalid or unknown steps.
- **Acceptance criteria**:
  - Unknown uses or invalid with fails validation; error code PIPELINE_INVALID.
- **Test vectors**: TV-PIPE-004, TV-PIPE-006
- **Notes**: Schema in schemas/pipeline.schema.json.

### SEC-004
- **Priority**: P1
- **Statement**: CiFn's own secrets (runner registration token, webhook signing) MUST be stored in secfn; job secrets (e.g. HOSTFN_SSH_KEY) MUST also come from secfn.
- **Rationale**: Intent: same secrets story as stack.
- **Acceptance criteria**:
  - No hardcoded secrets; config points to secfn for tokens and signing keys.
- **Test vectors**: TV-SEC-005
- **Notes**: Operational requirement.

### SEC-005
- **Priority**: P1
- **Statement**: Single-tenant by default; run/job access by runId; no cross-tenant visibility. Authz: caller can access only runs (and children) they are allowed to see (e.g. same tenant or creator).
- **Rationale**: Security model.
- **Acceptance criteria**:
  - Unauthorized runId access returns 404 or 403; no listing of other tenant's runs when multi-tenant added.
- **Test vectors**: TV-SEC-002
- **Notes**: v1 single-tenant implies all authed users see all runs unless scoped.

---

## Integrations

### INT-001
- **Priority**: P0
- **Statement**: Job queue and DAG execution MUST use flowfn (enqueue jobs, dequeue by runner, cron for schedule triggers).
- **Rationale**: Intent: flowfn for queue and orchestration.
- **Acceptance criteria**:
  - Run creation enqueues root jobs to flowfn; runner receives job from flowfn; schedule trigger uses flowfn scheduler.
- **Test vectors**: TV-INT-001
- **Notes**: flowfn client in control plane and runner.

### INT-002
- **Priority**: P0
- **Statement**: Artifact storage and retrieval MUST use filefn (upload step writes to filefn; download step and GET /runs/:runId/artifacts use filefn).
- **Rationale**: Intent: filefn for artifacts.
- **Acceptance criteria**:
  - artifact/upload stores in filefn; artifact/download and API return filefn refs/urls.
- **Test vectors**: TV-INT-002
- **Notes**: Run-scoped namespace in filefn.

### INT-003
- **Priority**: P0
- **Statement**: Secrets (job env, runner token, webhook signing) MUST be stored and retrieved via secfn; injection at job start only.
- **Rationale**: Intent: secfn for all secrets.
- **Acceptance criteria**:
  - Pipeline secrets.* resolved via secfn; runner token and API key from secfn.
- **Test vectors**: TV-SEC-003, TV-INT-004
- **Notes**: No secrets in control plane DB plaintext.

### INT-004
- **Priority**: P0
- **Statement**: Pipeline logs (step output, run/job events) MUST be sent to logfn; control plane MUST NOT log secret values.
- **Rationale**: Intent: logfn for observability.
- **Acceptance criteria**:
  - Step stdout/stderr and run/job status changes logged to logfn; log content does not contain secret values.
- **Test vectors**: TV-OBS-001, TV-OBS-002
- **Notes**: logfn client in runner and control plane.

### INT-005
- **Priority**: P1
- **Statement**: Checkout step MUST use repo + ref from pipelineRef or trigger payload; clone via git or plugfn (e.g. GitHub provider) when private; credentials from secfn.
- **Rationale**: Intent: plugfn for webhooks and repo access.
- **Acceptance criteria**:
  - Push/pull_request trigger provides ref; checkout clones that ref; private repo uses credentials from secfn/plugfn.
- **Test vectors**: TV-INT-005
- **Notes**: plugfn webhook for trigger; clone may be git CLI + token.

### INT-006
- **Priority**: P0
- **Statement**: hostfn/deploy step MUST invoke hostfn CLI with environment and --ci; testfn/run step MUST invoke testfn SDK with config and reporter options.
- **Rationale**: Intent: hostfn and testfn steps.
- **Acceptance criteria**:
  - hostfn step runs hostfn deploy &lt;env&gt; --ci with env vars from secfn; testfn step runs testfn with given config.
- **Test vectors**: TV-INT-004, TV-INT-006
- **Notes**: hostfn-runner can use --local --ci.

---

## CLI

### CLI-001
- **Priority**: P0
- **Statement**: cifn run [--config path] [--trigger type] MUST parse local pipeline (default config path .ci/pipeline.yml or cifn.yml), create run via API (or run locally if --local); exit 0 on success, non-zero on failure; MUST NOT print secrets.
- **Rationale**: Intent: one CLI for run.
- **Acceptance criteria**:
  - With valid pipeline and API, run created and exit 0; invalid pipeline or API error exits non-zero; no secret in stdout/stderr.
- **Test vectors**: TV-CLI-001, TV-CLI-002
- **Notes**: --config overrides default path.

### CLI-002
- **Priority**: P0
- **Statement**: cifn status [runId] MUST list recent runs (GET /runs) when runId omitted, or show run detail (GET /runs/:runId) when runId provided; output machine-readable (JSON) or human-readable per --format.
- **Rationale**: Intent: status command.
- **Acceptance criteria**:
  - cifn status returns run list; cifn status &lt;runId&gt; returns run detail; --format json yields valid JSON.
- **Test vectors**: TV-CLI-003
- **Notes**: Default format human-readable.

### CLI-003
- **Priority**: P0
- **Statement**: cifn logs &lt;runId&gt; [jobKey] MUST fetch logs for run (and optional job) via API; MUST NOT emit secret values.
- **Rationale**: Intent: logs command.
- **Acceptance criteria**:
  - Logs for run/job displayed; secret values redacted or absent.
- **Test vectors**: TV-CLI-004, TV-OBS-002
- **Notes**: Stream or buffer.

### CLI-004
- **Priority**: P1
- **Statement**: Config path MUST be configurable via env or flag; default .ci/pipeline.yml or cifn.yml.
- **Rationale**: Config in repo; path flexibility.
- **Acceptance criteria**:
  - CIFN_CONFIG or --config sets path; default used when unset.
- **Test vectors**: TV-PIPE-010
- **Notes**: Single file.

---

## Observability

### OBS-001
- **Priority**: P0
- **Statement**: Control plane MUST log to logfn (or equivalent): run created, run status change, job started/completed, step started/completed, runner registered/heartbeat, pipeline parse errors, API errors (with code, no secrets).
- **Rationale**: Observability.
- **Acceptance criteria**:
  - Each event type appears in logs; API errors include code; no secret in log message.
- **Test vectors**: TV-OBS-001
- **Notes**: Structured logging preferred.

### OBS-002
- **Priority**: P0
- **Statement**: System MUST NOT log: secret values, full request bodies that may contain secrets, runner tokens in plaintext.
- **Rationale**: Security.
- **Acceptance criteria**:
  - Log content never contains secret or token value; request body logged only with secrets redacted.
- **Test vectors**: TV-OBS-002, TV-SEC-003
- **Notes**: Redaction in logger.

### OBS-003
- **Priority**: P1
- **Statement**: System MAY emit to watchfn: run duration, job duration, step duration, failure counts, queue depth; metrics MUST NOT include PII or secrets.
- **Rationale**: Intent: watchfn for monitoring.
- **Acceptance criteria**:
  - When watchfn integrated, metrics exported; no PII in metric labels.
- **Test vectors**: TV-OBS-003
- **Notes**: Optional integration.

---

## Limits

### LIMIT-001
- **Priority**: P0
- **Statement**: Pipeline document size MUST NOT exceed 500 KB; jobs per pipeline max 100; steps per job max 100; needs depth max 10; GET /runs limit max 100 per request; expression length max 2 KB; artifact name max 256 chars; cache key max 1 KB.
- **Rationale**: Limits/caps from spec.
- **Acceptance criteria**:
  - Validation rejects oversized doc or counts; API rejects limit &gt; 100; long expression or artifact name rejected or truncated per spec.
- **Test vectors**: TV-LIMIT-001, TV-LIMIT-002, TV-LIMIT-003
- **Notes**: Artifact size bounded by filefn.

### LIMIT-002
- **Priority**: P1
- **Statement**: Pipeline parse + validation MUST complete in &lt; 500ms for configs up to 500 KB. Job dispatch to runner &lt; 5s p99 when runner available. Run listing (GET /runs) with paging &lt; 2s for 1000 runs.
- **Rationale**: Performance constraints.
- **Acceptance criteria**:
  - Benchmarks or tests assert timing under load within bounds.
- **Test vectors**: TV-LIMIT-004
- **Notes**: Best effort in v1.

### LIMIT-003
- **Priority**: P1
- **Statement**: v1 scaling: fixed set of runners; queue depth bounded by flowfn. No requirement for auto-scaling runners in v1.
- **Rationale**: Intent: v1 fixed runners.
- **Acceptance criteria**:
  - Documentation states fixed runners; no MUST for dynamic runner pool in v1.
- **Test vectors**: N/A (documentation)
- **Notes**: Later phase may add scaling.

---

## Dashboard

### DASH-001
- **Priority**: P1
- **Statement**: A dashboard (uifn/docsfn style) MUST provide run list, run detail (jobs, steps, logs), and artifact list; data from control plane API; auth same as API.
- **Rationale**: Intent: dashboard for run history and logs.
- **Acceptance criteria**:
  - Dashboard renders run list and run detail; logs and artifacts accessible; auth required.
- **Test vectors**: TV-DASH-001
- **Notes**: Optional sendfn notifications separate.

### DASH-002
- **Priority**: P2
- **Statement**: Optional sendfn notification on run/job failure or success MAY be configured per pipeline or globally.
- **Rationale**: Intent: optional sendfn.
- **Acceptance criteria**:
  - When configured, run completion (success/failure) triggers sendfn; no MUST for default.
- **Test vectors**: TV-DASH-002
- **Notes**: MAY; not required for spec completeness.
