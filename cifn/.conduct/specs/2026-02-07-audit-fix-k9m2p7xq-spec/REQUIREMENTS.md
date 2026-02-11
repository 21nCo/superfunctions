# CiFn Requirements (audit-fix)

## Table of contents

- [PIPE-001](#pipe-001) … [PIPE-012](#pipe-012) Pipeline and config
- [API-001](#api-001) … [API-011](#api-011) Control plane API
- [RUN-001](#run-001) … [RUN-010](#run-010) Runs, jobs, steps
- [RUNNER-001](#runner-001) … [RUNNER-005](#runner-005) Runners
- [SEC-001](#sec-001) … [SEC-006](#sec-006) Security
- [INT-001](#int-001) … [INT-008](#int-008) Integrations
- [OBS-001](#obs-001) … [OBS-003](#obs-003) Observability
- [CLI-001](#cli-001) … [CLI-005](#cli-005) CLI
- [DASH-001](#dash-001) … [DASH-002](#dash-002) Dashboard
- [DEPLOY-001](#deploy-001) … [DEPLOY-002](#deploy-002) Self-deployability
- [LIMIT-001](#limit-001) … [LIMIT-003](#limit-003) Limits / caps

---

## Pipeline and config

### PIPE-001
- **Priority**: P0
- **Statement**: The system MUST accept pipeline config as YAML or JSON with `name`, `on`, optional `env`, and `jobs` (each job: `runs-on`, optional `needs`, optional `if`, optional `env`, `steps`).
- **Rationale**: Pipeline-as-config is a core goal and the entrypoint for all CI behavior.
- **Acceptance criteria**:
  - Valid YAML parses into a canonical PipelineSpec.
  - Valid JSON parses into the same canonical PipelineSpec as equivalent YAML.
  - Invalid YAML/JSON fails with `PIPELINE_INVALID` (not a crash).
- **Test vectors**: TV-PIPE-001, TV-PIPE-002, TV-PIPE-003
- **Notes**: Canonical job order is derived deterministically from `jobs` keys + `needs` (see PIPE-007).

### PIPE-002
- **Priority**: P0
- **Statement**: The system MUST validate pipeline config against `schemas/pipeline.schema.json` and reject unknown keys and invalid types at validation time.
- **Rationale**: Prevent unsafe/undefined runtime behavior by enforcing schema boundaries.
- **Acceptance criteria**:
  - Unknown top-level keys fail validation.
  - Unknown job-level keys fail validation.
  - Step objects that are neither `run` nor `uses` fail validation.
- **Test vectors**: TV-PIPE-004, TV-PIPE-005
- **Notes**: Validation MUST occur before any job is enqueued or executed.

### PIPE-003
- **Priority**: P0
- **Statement**: Supported step types MUST include `run` and `uses` in the allowlist: `checkout`, `cache/restore`, `cache/save`, `artifact/upload`, `artifact/download`, `testfn/run`, `hostfn/deploy`.
- **Rationale**: These are the explicit step types in authoritative intent.
- **Acceptance criteria**:
  - Each allowed `uses` value is accepted by schema + semantic validation.
  - Any non-allowlisted `uses` is rejected with `PIPELINE_INVALID`.
- **Test vectors**: TV-PIPE-006, TV-PIPE-007
- **Notes**: Any “marketplace” action behavior is Undefined for v1.

### PIPE-004
- **Priority**: P0
- **Statement**: Triggers under `on` MUST support `push`, `pull_request`, `schedule`, and `workflow_dispatch`.
- **Rationale**: Webhook, cron, and manual triggers are core to CI.
- **Acceptance criteria**:
  - Each trigger shape is accepted in a valid pipeline.
  - Trigger type is preserved into Run context (`github.event_name`).
- **Test vectors**: TV-PIPE-008, TV-PIPE-009
- **Notes**: `schedule` normalization requirements are defined in PIPE-005.

### PIPE-005
- **Priority**: P0
- **Statement**: The parser MUST accept `on.schedule` as either an object `{cron:string}` or an array of `{cron:string}` and MUST normalize it to an array in canonical PipelineSpec.
- **Rationale**: Fixes the intent-vs-schema drift identified by audit and supports GHA-like UX.
- **Acceptance criteria**:
  - Input object schedule is accepted and becomes a single-element array in canonical spec.
  - Input array schedule is accepted and preserved.
  - Invalid cron expressions are rejected with `PIPELINE_INVALID`.
- **Test vectors**: TV-PIPE-010, TV-PIPE-011, TV-PIPE-012
- **Notes**: Cron syntax is implementation-defined but MUST be deterministic and documented.

### PIPE-006
- **Priority**: P0
- **Statement**: Pipeline resolution from a repo MUST support `pipelineRef` with default `configPath` fallback order `.ci/pipeline.yml`, `.ci/pipeline.yaml`, `cifn.yml`, `cifn.yaml`.
- **Rationale**: Repo-backed pipelines are required for real webhook-driven CI usage.
- **Acceptance criteria**:
  - For a repo/ref containing a valid config at any default path, run creation succeeds without specifying configPath.
  - If configPath is specified and missing, run creation fails with `RUN_CREATE_FAILED`.
  - Private repo auth is supported via secfn/plugfn (see RUN-007).
- **Test vectors**: TV-API-001, TV-API-004, TV-RUN-007
- **Notes**: Inline `pipelineSpec` support is defined in API-002 and exists for dev/test.

### PIPE-007
- **Priority**: P0
- **Statement**: Jobs MUST form a DAG via `needs`, and a job MUST NOT start until all `needs` jobs are `success` or `skipped`.
- **Rationale**: Deterministic DAG execution is a core CI invariant.
- **Acceptance criteria**:
  - Cycles are rejected at validation time.
  - Needs depth > 10 is rejected at validation time.
  - A job with needs starts only after prerequisites complete success or skipped.
- **Test vectors**: TV-RUN-001, TV-RUN-002, TV-PIPE-013
- **Notes**: If a needed job fails/cancels, dependent jobs MUST be skipped (RUN-003).

### PIPE-008
- **Priority**: P0
- **Statement**: `runs-on` MUST be used to dispatch jobs to matching runners and MUST support `default` and `hostfn-runner` plus arbitrary label strings.
- **Rationale**: Runners are the execution substrate; dispatch must be predictable.
- **Acceptance criteria**:
  - A registered runner with label `default` can claim a `runs-on: default` job.
  - A registered runner with label `hostfn-runner` can claim a `runs-on: hostfn-runner` job.
  - A job with `runs-on` that has no matching runner remains queued until a matching runner exists (or times out per policy).
- **Test vectors**: TV-RUNNER-001, TV-RUNNER-002
- **Notes**: Timeout policy is defined in LIMIT-003 (Undefined beyond caps unless specified).

### PIPE-009
- **Priority**: P0
- **Statement**: The system MUST implement `if` evaluation for jobs and steps, including default step condition `success()` and functions `success()`, `failure()`, and `always()`.
- **Rationale**: Audit identified missing `if` semantics; intent requires branch gating and failure-only artifact upload.
- **Acceptance criteria**:
  - Step without `if` runs only when `success()` is true.
  - After a step failure, subsequent steps are evaluated and steps with `if: failure()` can run.
  - Job with `if` false is marked `skipped` and satisfies `needs`.
- **Test vectors**: TV-EXPR-001, TV-EXPR-002, TV-EXPR-003, TV-EXPR-004
- **Notes**: Expression language is constrained in PIPE-010.

### PIPE-010
- **Priority**: P0
- **Statement**: The system MUST support deterministic expression evaluation and `${{ ... }}` interpolation for `github.*`, `secrets.*`, and `hashFiles(...)` with max expression length 2048 chars.
- **Rationale**: Required for secret injection, conditional execution, and cache keying.
- **Acceptance criteria**:
  - `${{ github.ref }}` resolves from trigger context.
  - `${{ secrets.NAME }}` resolves from secfn and is treated as secret material (redacted).
  - `${{ hashFiles('pattern') }}` returns deterministic hex hash and handles “no matches” deterministically.
  - Expressions longer than 2048 chars are rejected with `PIPELINE_INVALID`.
- **Test vectors**: TV-EXPR-005, TV-EXPR-006, TV-EXPR-007, TV-EXPR-008
- **Notes**: Supported operators are limited; unsupported syntax MUST fail fast with `PIPELINE_INVALID`.

### PIPE-011
- **Priority**: P0
- **Statement**: The pipeline schema/validator MUST enforce step-type-specific `with` shapes and MUST reject unknown `with` keys for known `uses`.
- **Rationale**: Audit identified unconstrained `with` as a validation/security gap.
- **Acceptance criteria**:
  - `checkout.with` only permits documented keys (e.g. repository/ref/token) and rejects unknown keys.
  - `artifact/upload.with` requires `name` and `path` and rejects extra keys.
  - `cache/*` and `hostfn/deploy` and `testfn/run` have enforced shapes.
- **Test vectors**: TV-PIPE-014, TV-PIPE-015, TV-PIPE-016
- **Notes**: Schema MAY be complemented by semantic validation; both MUST agree.

### PIPE-012
- **Priority**: P0
- **Statement**: Pipeline validation MUST enforce caps: document size ≤ 500KB, jobs ≤ 100, steps/job ≤ 100, needs depth ≤ 10.
- **Rationale**: Intent specifies concrete limits; prevents DoS and runaway configs.
- **Acceptance criteria**:
  - Oversized pipeline is rejected with `PIPELINE_INVALID`.
  - Too many jobs/steps/depth is rejected with `PIPELINE_INVALID`.
- **Test vectors**: TV-PIPE-004, TV-LIMIT-001, TV-LIMIT-002
- **Notes**: See LIMIT-001.

---

## Control plane API

### API-001
- **Priority**: P0
- **Statement**: All API responses MUST use the canonical JSON envelope `{ok:true,data}` / `{ok:false,error}` and MUST NOT return bare bodies (including runner heartbeat).
- **Rationale**: Fixes spec/implementation ambiguity and simplifies clients.
- **Acceptance criteria**:
  - Success responses always include `ok:true` and `data`.
  - Error responses always include `ok:false` and `error.code`.
- **Test vectors**: TV-API-006, TV-API-007
- **Notes**: HTTP status codes are defined in SPEC.md.

### API-002
- **Priority**: P0
- **Statement**: `POST /api/v1/runs` MUST accept either `pipelineRef` or inline `pipelineSpec` and MUST create a queued run when inputs are valid.
- **Rationale**: Fixes pipelineRef gap while keeping dev/test inline creation.
- **Acceptance criteria**:
  - `pipelineRef` that resolves to a valid repo config creates a run.
  - `pipelineSpec` with valid schema creates a run (workflow_dispatch).
  - Missing both returns `BAD_REQUEST`.
- **Test vectors**: TV-API-001, TV-API-002, TV-API-003
- **Notes**: If both are provided, `pipelineSpec` takes precedence.

### API-003
- **Priority**: P0
- **Statement**: `GET /api/v1/runs` MUST implement paging with `limit` (≤100) and `cursor`, and invalid cursors MUST return `BAD_REQUEST`.
- **Rationale**: Audit identified cursor-invalid behavior mismatch; paging is required for UX.
- **Acceptance criteria**:
  - limit defaults to 20 and caps at 100 (or rejects >100 with `BAD_REQUEST`).
  - Results are sorted by createdAt descending.
  - Invalid cursor is rejected with `BAD_REQUEST`.
- **Test vectors**: TV-API-008, TV-API-009, TV-API-010
- **Notes**: Cursor is opaque to clients.

### API-004
- **Priority**: P0
- **Statement**: `GET /api/v1/runs/:runId` MUST return run detail with canonical identifiers (`runId`, `jobKey`, step identity) or `RUN_NOT_FOUND`.
- **Rationale**: Dashboard/CLI depend on stable contract; fixes runId/id mismatch exposure.
- **Acceptance criteria**:
  - Existing run returns full run tree.
  - Missing run returns `RUN_NOT_FOUND`.
- **Test vectors**: TV-API-011, TV-API-012
- **Notes**: Response MUST NOT contain secret values.

### API-005
- **Priority**: P0
- **Statement**: `POST /api/v1/runs/:runId/cancel` MUST cancel queued/running runs and MUST return `RUN_ALREADY_FINISHED` when run is terminal.
- **Rationale**: User control of CI runs.
- **Acceptance criteria**:
  - Cancelling queued/running run yields status cancelled.
  - Cancelling success/failure yields `RUN_ALREADY_FINISHED`.
- **Test vectors**: TV-API-013, TV-API-014
- **Notes**: Cancelling already cancelled is idempotent.

### API-006
- **Priority**: P1
- **Statement**: `GET /api/v1/runs/:runId/jobs/:jobKey/logs` MUST return redacted logs for the job and MUST NOT leak secrets.
- **Rationale**: Required for CLI and dashboard.
- **Acceptance criteria**:
  - Valid runId/jobKey returns lines array.
  - Missing job returns 404 with `RUN_NOT_FOUND` or `BAD_REQUEST` (as specified).
  - Secret values are never present in returned lines.
- **Test vectors**: TV-API-015, TV-SEC-001
- **Notes**: Error code choice for “job not found” is implementation-defined but MUST be consistent.

### API-007
- **Priority**: P1
- **Statement**: `GET /api/v1/runs/:runId/artifacts` MUST return run-scoped artifact metadata including `name` and either `fileId` or signed `url` when available.
- **Rationale**: Artifacts are core for build/test/deploy workflows.
- **Acceptance criteria**:
  - Artifacts uploaded by steps appear in list.
  - Runs with no artifacts return empty list.
- **Test vectors**: TV-API-016, TV-API-017, TV-INT-002
- **Notes**: URL expiration is Undefined but MUST be time-limited if provided.

### API-008
- **Priority**: P0
- **Statement**: The control plane MUST require API authentication for `/api/v1/*` endpoints (except optional `/health`) and MUST return `UNAUTHORIZED` when missing/invalid.
- **Rationale**: Security boundary for CI.
- **Acceptance criteria**:
  - Missing auth yields 401 UNAUTHORIZED.
  - Valid auth allows access.
- **Test vectors**: TV-SEC-002, TV-SEC-003
- **Notes**: Token source of truth is secfn.

### API-009
- **Priority**: P0
- **Statement**: Error responses MUST use only the canonical error code set defined in SPEC.md (including `UNAUTHORIZED`).
- **Rationale**: Fixes audit-identified error code drift.
- **Acceptance criteria**:
  - All error paths emit one of the allowed codes.
  - No unknown codes are emitted.
- **Test vectors**: TV-API-007, TV-SEC-002
- **Notes**: This requirement constrains both control plane and runner-facing endpoints.

### API-010
- **Priority**: P0
- **Statement**: Runner registration MUST return a runner-scoped secret and heartbeat MUST require that runner-scoped secret (not the registration token).
- **Rationale**: Fixes a critical auth weakness identified in audit.
- **Acceptance criteria**:
  - Register returns `{runnerId, runnerSecret}` once.
  - Heartbeat with registration token fails with `UNAUTHORIZED`.
  - Heartbeat with runnerSecret succeeds.
- **Test vectors**: TV-RUNNER-003, TV-RUNNER-004, TV-RUNNER-005
- **Notes**: Server stores only hash of runnerSecret (SEC-004).

### API-011
- **Priority**: P1
- **Statement**: `POST /api/v1/runners/heartbeat` MUST return `ok:true` with `job:null` when no job is available (not 204).
- **Rationale**: Removes envelope ambiguity and makes clients simpler.
- **Acceptance criteria**:
  - No-job heartbeat response is JSON envelope with job null.
- **Test vectors**: TV-RUNNER-006, TV-API-007
- **Notes**: Long-polling is Undefined; simple poll is sufficient.

---

## Runs, jobs, steps

### RUN-001
- **Priority**: P0
- **Statement**: A run MUST have status in `{queued,running,success,failure,cancelled}` and MUST NOT transition out of terminal states `{success,failure,cancelled}`.
- **Rationale**: Consistency invariant for all clients and the scheduler.
- **Acceptance criteria**:
  - Terminal state immutability is enforced in store/state machine.
- **Test vectors**: TV-RUN-001, TV-API-013
- **Notes**: updatedAt MUST be monotonic per run.

### RUN-002
- **Priority**: P0
- **Statement**: A job MUST have status in `{pending,running,success,failure,skipped}` and a step MUST have status in `{pending,running,success,failure,skipped}`.
- **Rationale**: Required for reporting and `if` semantics.
- **Acceptance criteria**:
  - Status values are consistent across API, store, runner reporting.
- **Test vectors**: TV-RUN-002, TV-EXPR-001
- **Notes**: Additional status values are not allowed in v1.

### RUN-003
- **Priority**: P0
- **Statement**: If any job in a job’s `needs` is `failure` or `cancelled`, the dependent job MUST be marked `skipped` and MUST NOT run.
- **Rationale**: Safety and correctness; prevents deploy after failed build/test.
- **Acceptance criteria**:
  - When build fails, deploy is skipped (not run).
- **Test vectors**: TV-RUN-003, TV-EXPR-002
- **Notes**: Exact skip reason text is Undefined.

### RUN-004
- **Priority**: P0
- **Statement**: Step execution order within a job MUST follow the order in the pipeline config and MUST remain deterministic.
- **Rationale**: CI semantics require predictable step ordering.
- **Acceptance criteria**:
  - Steps start/complete in config order (except skipped steps still preserve order).
- **Test vectors**: TV-EXPR-001, TV-RUN-004
- **Notes**: Parallel steps are Undefined in v1.

### RUN-005
- **Priority**: P1
- **Statement**: `artifact/upload` MUST upload the specified path to filefn and `artifact/download` MUST restore it into the job workspace by artifact name.
- **Rationale**: Artifacts enable build outputs and failure diagnostics.
- **Acceptance criteria**:
  - Upload produces an artifact entry visible via API-007.
  - Download restores identical content (byte-for-byte) into workspace.
- **Test vectors**: TV-INT-002, TV-RUN-005
- **Notes**: Artifact overwrites are Undefined; MUST fail or be deterministic.

### RUN-006
- **Priority**: P1
- **Statement**: `cache/restore` and `cache/save` MUST implement key-based restore/save with keys supporting `${{ hashFiles(...) }}`.
- **Rationale**: Dependency caching is needed for CI performance and aligns with intent.
- **Acceptance criteria**:
  - Save writes cache for specified paths under key.
  - Restore restores paths when key hit.
  - hashFiles changes key when file content changes.
- **Test vectors**: TV-EXPR-007, TV-INT-003, TV-RUN-006
- **Notes**: Cache eviction policy is Undefined.

### RUN-007
- **Priority**: P0
- **Statement**: `checkout` MUST support cloning private repos using a token sourced from secfn/plugfn and MUST NOT leak that token in logs.
- **Rationale**: Real CI requires private repo support; audit identified token leakage risk.
- **Acceptance criteria**:
  - Private repo clone succeeds when token is valid.
  - If git prints URLs/errors, output is redacted so the token is never visible.
- **Test vectors**: TV-RUN-007, TV-SEC-001
- **Notes**: Repo provider matrix is Undefined beyond GitHub-compatible URLs.

### RUN-008
- **Priority**: P0
- **Statement**: `testfn/run` MUST execute tests via the testfn SDK and `hostfn/deploy` MUST deploy via hostfn using secfn-sourced secrets.
- **Rationale**: Ecosystem-native behavior is core intent; audit identified divergence.
- **Acceptance criteria**:
  - testfn step uses testfn SDK APIs (not ad-hoc `npx vitest` wrapper).
  - hostfn deploy uses `--ci` and supports `--local` when on hostfn-runner.
  - Secrets required by hostfn are injected from secfn and not logged.
- **Test vectors**: TV-INT-006, TV-RUNNER-002, TV-SEC-001
- **Notes**: Exact hostfn commandline is part of test vectors.

### RUN-009
- **Priority**: P0
- **Statement**: The runner MUST continue evaluating steps after a step failure so that `if: failure()` and `if: always()` steps can run.
- **Rationale**: Needed for failure-only artifact uploads; audit identified current stop-on-failure gap.
- **Acceptance criteria**:
  - After a failure, subsequent steps with `if: failure()` run.
  - Subsequent steps without `if` are skipped (default `success()`).
- **Test vectors**: TV-EXPR-001, TV-EXPR-003
- **Notes**: Job final status remains failure.

### RUN-010
- **Priority**: P1
- **Statement**: Run creation via webhook triggers MUST use `pipelineRef` (repo/ref/configPath) rather than inline `pipelineSpec`.
- **Rationale**: Ensures repo-backed configuration for real CI usage.
- **Acceptance criteria**:
  - Webhook handler resolves pipeline via pipelineRef and default config path order.
- **Test vectors**: TV-INT-005, TV-API-001
- **Notes**: Inline pipelineSpec remains allowed for workflow_dispatch and dev/test.

---

## Runners

### RUNNER-001
- **Priority**: P0
- **Statement**: A runner MUST execute only the steps provided in the claimed job payload and MUST NOT execute any additional remote code beyond declared step types.
- **Rationale**: Reduces remote-code execution surface.
- **Acceptance criteria**:
  - Runner does not evaluate arbitrary scripts except `run` step content.
  - Unknown step shapes are rejected and mark job as failure with a defined error.
- **Test vectors**: TV-RUNNER-007, TV-PIPE-005
- **Notes**: `run` steps are arbitrary shell and are explicitly allowed.

### RUNNER-002
- **Priority**: P1
- **Statement**: A default runner MUST support executing `run` steps inside a Docker image when `job.image` is provided.
- **Rationale**: Containerized builds are standard CI behavior.
- **Acceptance criteria**:
  - With image set, run steps execute in container with workspace mounted.
  - Without image set, run steps execute on host.
- **Test vectors**: TV-RUNNER-002, TV-RUNNER-008
- **Notes**: Container runtime specifics are implementation-defined.

### RUNNER-003
- **Priority**: P0
- **Statement**: Runner heartbeat MUST be authenticated with runner-scoped secret and MUST be bound to `runnerId`.
- **Rationale**: Prevents runner impersonation.
- **Acceptance criteria**:
  - Wrong runnerSecret for runnerId fails UNAUTHORIZED.
- **Test vectors**: TV-RUNNER-004, TV-RUNNER-005
- **Notes**: See API-010.

### RUNNER-004
- **Priority**: P1
- **Statement**: `runs-on: hostfn-runner` MUST cause `hostfn/deploy` to run with `--local --ci` semantics.
- **Rationale**: Intent explicitly calls out hostfn-runner local deploy.
- **Acceptance criteria**:
  - hostfn step includes `--ci`.
  - hostfn-runner includes `--local`.
- **Test vectors**: TV-RUNNER-002, TV-INT-006
- **Notes**: If runs-on is not hostfn-runner, `--local` is not required.

### RUNNER-005
- **Priority**: P0
- **Statement**: The runner MUST redact secret values from captured stdout/stderr before sending logs to the control plane.
- **Rationale**: Secrets must not leak via logs.
- **Acceptance criteria**:
  - Any configured secret value in output is replaced with `***` (or equivalent).
- **Test vectors**: TV-SEC-001, TV-OBS-003
- **Notes**: Redaction algorithm must be deterministic.

---

## Security

### SEC-001
- **Priority**: P0
- **Statement**: Secret values sourced from secfn MUST NOT appear in any logs, API responses, dashboard UI, or CLI output.
- **Rationale**: Core security invariant and explicit intent “must not”.
- **Acceptance criteria**:
  - Job that echoes a secret never exposes the raw secret value via logs endpoint.
  - Run detail never includes secret values.
- **Test vectors**: TV-SEC-001, TV-SEC-004
- **Notes**: Applies to checkout tokens too (RUN-007).

### SEC-002
- **Priority**: P0
- **Statement**: Webhook triggers MUST verify request authenticity (HMAC signature or plugfn verifier) and MUST reject unverified webhooks.
- **Rationale**: Prevents unauthorized pipeline execution.
- **Acceptance criteria**:
  - Invalid signature yields error and does not create run.
  - Valid signature yields run creation.
- **Test vectors**: TV-SEC-005, TV-INT-005
- **Notes**: Provider-specific header names are implementation-defined but MUST be documented.

### SEC-003
- **Priority**: P0
- **Statement**: API authentication MUST be enforced for `/api/v1/*` endpoints and missing/invalid credentials MUST return `UNAUTHORIZED`.
- **Rationale**: Control-plane boundary.
- **Acceptance criteria**:
  - Missing auth returns 401 UNAUTHORIZED.
  - Invalid auth returns 401 UNAUTHORIZED.
- **Test vectors**: TV-SEC-002, TV-SEC-003
- **Notes**: Health endpoint may be unauthenticated.

### SEC-004
- **Priority**: P0
- **Statement**: Runner-scoped secrets MUST be stored only as hashes server-side and MUST never be persisted in plaintext.
- **Rationale**: Limits blast radius if store is compromised.
- **Acceptance criteria**:
  - No storage backend writes runnerSecret plaintext.
  - Hash compare is used for auth.
- **Test vectors**: TV-RUNNER-003, TV-SEC-006
- **Notes**: Hash algorithm is implementation-defined but MUST be documented.

### SEC-005
- **Priority**: P1
- **Statement**: The system MUST operate as single-tenant by default where any valid API credential has access to all runs.
- **Rationale**: Aligns intent (“single-tenant by default”) and resolves audit mismatch about authz expectations.
- **Acceptance criteria**:
  - Two different valid API keys can both list and read the same run.
- **Test vectors**: TV-SEC-003, TV-API-011
- **Notes**: Multi-tenant RBAC is Undefined (out of scope).

### SEC-006
- **Priority**: P0
- **Statement**: The control plane MUST NOT persist plaintext job secrets in run/job/step records.
- **Rationale**: Prevents secrets at rest leakage.
- **Acceptance criteria**:
  - Store contains only secret names/handles, not secret values.
- **Test vectors**: TV-SEC-004, TV-INT-004
- **Notes**: Secret names (e.g. `HOSTFN_SSH_KEY`) are not considered secret values.

---

## Integrations

### INT-001
- **Priority**: P0
- **Statement**: The control plane MUST enqueue and dispatch jobs using a flowfn-backed queue in production and MUST provide a memory adapter for tests/local dev.
- **Rationale**: Intent requires flowfn; audit identified in-memory stubs only.
- **Acceptance criteria**:
  - There is a configurable queue adapter with at least `memory` and one real flowfn-backed implementation.
  - End-to-end dispatch works with the configured adapter.
- **Test vectors**: TV-INT-001, TV-RUNNER-006
- **Notes**: “Production” is defined by config (not environment name).

### INT-002
- **Priority**: P0
- **Statement**: Artifacts MUST be stored using a filefn-backed implementation in production and MUST provide a memory adapter for tests/local dev.
- **Rationale**: Intent requires filefn for artifacts.
- **Acceptance criteria**:
  - Artifact upload produces a filefn fileId (or equivalent) in production mode.
  - Artifact download can fetch by name and restore workspace content.
- **Test vectors**: TV-INT-002, TV-RUN-005
- **Notes**: Signed URL behavior is defined by API-007.

### INT-003
- **Priority**: P0
- **Statement**: Secrets and tokens (API keys, runner registration token, job secrets) MUST be sourced from secfn via a configurable adapter.
- **Rationale**: Intent requires secfn; audit found partial secret injection.
- **Acceptance criteria**:
  - API keys are loaded/validated via secfn adapter.
  - Runner registration token is validated via secfn adapter.
  - Job secrets referenced by `${{ secrets.* }}` resolve via secfn adapter.
- **Test vectors**: TV-INT-003, TV-SEC-004
- **Notes**: A memory secfn adapter is acceptable for tests, but a real adapter MUST exist.

### INT-004
- **Priority**: P0
- **Statement**: Control plane and runner MUST emit structured logs via logfn (library and/or service sink) and MUST support retrieving job logs through the API.
- **Rationale**: Observability is core and required for dashboard/CLI.
- **Acceptance criteria**:
  - run/job/step lifecycle emits log events (see OBS-001).
  - logs endpoint returns those logs in redacted form.
- **Test vectors**: TV-OBS-001, TV-API-015
- **Notes**: watchfn metrics are optional (OBS-002).

### INT-005
- **Priority**: P1
- **Statement**: Webhook-based triggers MUST integrate with plugfn or an equivalent provider integration to support signature verification and repo/ref extraction.
- **Rationale**: Intent references plugfn for webhooks/repo access.
- **Acceptance criteria**:
  - Verified webhook produces pipelineRef and creates run.
  - Unverified webhook is rejected.
- **Test vectors**: TV-INT-005, TV-SEC-005
- **Notes**: Direct HMAC verification is acceptable if plugfn is not used for verification, but repo/ref extraction MUST be correct.

### INT-006
- **Priority**: P0
- **Statement**: `testfn/run` MUST be implemented using the testfn SDK and MUST support at least the vitest adapter and JSON reporter output.
- **Rationale**: Audit identified current implementation does not use testfn SDK.
- **Acceptance criteria**:
  - Step results include a produced JSON report artifact (or file) deterministically named.
  - Failures are reflected in step/job status.
- **Test vectors**: TV-INT-006, TV-EXPR-003
- **Notes**: Additional frameworks are optional if not required by pipelines.

### INT-007
- **Priority**: P0
- **Statement**: `hostfn/deploy` MUST invoke hostfn CLI (or SDK if available) with `--ci` and MUST support `--local` for hostfn-runner.
- **Rationale**: Ecosystem-native deployments are core intent.
- **Acceptance criteria**:
  - Command invocation includes required flags and environment.
- **Test vectors**: TV-INT-007, TV-RUNNER-002
- **Notes**: Remote SSH deployment is hostfn’s domain.

### INT-008
- **Priority**: P2
- **Statement**: The system MAY support “hybrid trigger mode” where an external CI system triggers CiFn runs via API/webhook while CiFn executes jobs on its own runners and exposes logs/artifacts via its API.
- **Rationale**: Authoritative intent explicitly calls out hybrid usage patterns as an optional way to adopt CiFn incrementally.
- **Acceptance criteria**:
  - Documentation includes at least one working example of an external system (e.g. GitHub Actions) triggering CiFn.
  - The triggered run behaves the same as a native workflow_dispatch run (run history/logs/artifacts visible in CiFn).
- **Test vectors**: TV-INT-008, TV-INT-008N
- **Notes**: This is an optional capability; lack of this feature MUST NOT block core CI execution.

---

## Observability

### OBS-001
- **Priority**: P0
- **Statement**: The system MUST emit structured lifecycle events for runs, jobs, and steps (`run.created`, `job.started`, `step.completed`, etc.) and MUST include `runId` and `jobKey` in each event.
- **Rationale**: Required to debug CI runs and to build dashboards.
- **Acceptance criteria**:
  - For a simple run, emitted events include run/job/step start+complete.
- **Test vectors**: TV-OBS-001, TV-OBS-002
- **Notes**: Event schema is defined in SPEC.md Observability.

### OBS-002
- **Priority**: P2
- **Statement**: The system MAY emit watchfn metrics for run durations and failure rates.
- **Rationale**: Optional per intent.
- **Acceptance criteria**:
  - If implemented, metrics have stable names and labels.
- **Test vectors**: TV-OBS-002, TV-OBS-002N
- **Notes**: Not required for correctness.

### OBS-003
- **Priority**: P0
- **Statement**: Checkout/auth tokens (e.g. `checkout.with.token`) MUST be treated as secrets for redaction purposes.
- **Rationale**: Audit identified a likely leak path via git clone URL and stderr.
- **Acceptance criteria**:
  - Any occurrence of the token in git output is redacted.
- **Test vectors**: TV-OBS-003, TV-RUN-007
- **Notes**: Token sources include secfn and webhook payloads (if any).

---

## CLI

### CLI-001
- **Priority**: P0
- **Statement**: `cifn run` MUST support remote run creation by reading local config from `--config` or default path resolution and calling the control plane API.
- **Rationale**: CLI is a primary user interface.
- **Acceptance criteria**:
  - Default config path is used when no --config is provided.
  - Valid config triggers remote run creation and prints runId.
- **Test vectors**: TV-CLI-001, TV-CLI-002
- **Notes**: Default search order: `.ci/pipeline.yml`, `.ci/pipeline.yaml`, `cifn.yml`, `cifn.yaml` unless overridden.

### CLI-002
- **Priority**: P1
- **Statement**: `cifn run --local` MUST execute the pipeline locally using the same runner engine semantics (including `if` behavior and redaction).
- **Rationale**: Intent allows standalone usage and improves developer iteration.
- **Acceptance criteria**:
  - Local run produces job/step statuses and logs consistent with remote semantics.
- **Test vectors**: TV-CLI-003, TV-EXPR-001
- **Notes**: Local mode does not require flowfn/filefn integrations if using local adapters, but semantics must match.

### CLI-003
- **Priority**: P0
- **Statement**: `cifn status` MUST list runs and show run detail using the control plane API.
- **Rationale**: Required to inspect run state.
- **Acceptance criteria**:
  - Lists recent runs.
  - Shows run detail for a given runId.
- **Test vectors**: TV-CLI-004, TV-API-011
- **Notes**: Output formats are implementation-defined but MUST include runId.

### CLI-004
- **Priority**: P0
- **Statement**: `cifn logs` MUST fetch logs from the control plane API and MUST NOT output unredacted secret values.
- **Rationale**: Prevent accidental secret leakage in terminal.
- **Acceptance criteria**:
  - Printed logs never include secret values.
- **Test vectors**: TV-CLI-005, TV-SEC-001
- **Notes**: If server redaction is correct, client-side redaction is defense-in-depth.

### CLI-005
- **Priority**: P1
- **Statement**: The CLI MUST support specifying the control plane URL and credentials via config or environment variables.
- **Rationale**: Required for self-hosted usage.
- **Acceptance criteria**:
  - CLI works when pointed at non-default URL with valid credentials.
- **Test vectors**: TV-CLI-006, TV-SEC-003
- **Notes**: Exact env var names are implementation-defined but MUST be documented.

---

## Dashboard

### DASH-001
- **Priority**: P0
- **Statement**: The dashboard MUST use the API’s canonical run identifier `runId` (not `id`) for list/detail navigation and data binding.
- **Rationale**: Audit found dashboard/API contract mismatch likely breaking UI.
- **Acceptance criteria**:
  - Run list renders from API response.
  - Clicking a run navigates to run detail using runId.
- **Test vectors**: TV-DASH-001, TV-DASH-001N, TV-API-011
- **Notes**: Dashboard auth uses same credentials as API.

### DASH-002
- **Priority**: P2
- **Statement**: The system MAY send notifications via sendfn on run completion/failure.
- **Rationale**: Optional per intent.
- **Acceptance criteria**:
  - When enabled, a notification is emitted on failure.
- **Test vectors**: TV-DASH-002, TV-DASH-002N
- **Notes**: Delivery channels are Undefined.

---

## Self-deployability

### DEPLOY-001
- **Priority**: P0
- **Statement**: The project MUST ship runnable deployment artifacts for the control plane and runner (Docker Compose and a hostfn-based deployment option).
- **Rationale**: Self-deployability is explicit intent and was a spec gap in the audited bundle.
- **Acceptance criteria**:
  - A `docker-compose.yml` (or equivalent) can boot a working control plane + runner locally.
  - A hostfn example/config can deploy both services on a hostfn-managed node.
- **Test vectors**: TV-DEPLOY-001, TV-DEPLOY-002, TV-DEPLOY-003N
- **Notes**: K8s manifests are optional.

### DEPLOY-002
- **Priority**: P0
- **Statement**: Deployment artifacts MUST document required environment variables/secrets and MUST reference secfn for secret storage.
- **Rationale**: Prevent insecure deployments and missing configuration.
- **Acceptance criteria**:
  - Docs enumerate required env vars for integrations and auth.
- **Test vectors**: TV-DEPLOY-003, TV-DEPLOY-003N
- **Notes**: Docs live in README or deployment folder.

---

## Limits / caps

### LIMIT-001
- **Priority**: P0
- **Statement**: The system MUST enforce caps listed in SPEC.md Limits/Caps including pipeline size, job/step counts, needs depth, list runs limit, expression length, artifact name length, and cache key length.
- **Rationale**: Intent includes concrete caps; protects system stability.
- **Acceptance criteria**:
  - Each cap has at least one unit/integration test verifying enforcement.
- **Test vectors**: TV-PIPE-004, TV-LIMIT-001, TV-LIMIT-002, TV-LIMIT-003
- **Notes**: Cap violation MUST return `PIPELINE_INVALID` or `BAD_REQUEST` as appropriate.

### LIMIT-002
- **Priority**: P1
- **Statement**: Pipeline parse+validate SHOULD complete within 500ms for configs ≤ 500KB on a typical dev server.
- **Rationale**: Performance target from intent (best-effort).
- **Acceptance criteria**:
  - A benchmark test exists and reports measured timing.
- **Test vectors**: TV-LIMIT-004, TV-LIMIT-004N
- **Notes**: This is not a strict CI gate unless explicitly configured.

### LIMIT-003
- **Priority**: P1
- **Statement**: The system SHOULD keep a fixed runner pool in v1 and MUST NOT auto-provision new runners.
- **Rationale**: Matches stated scaling intent for v1.
- **Acceptance criteria**:
  - No code path provisions runners dynamically.
- **Test vectors**: TV-LIMIT-005, TV-LIMIT-005N
- **Notes**: Later versions may add autoscaling under a new spec.

