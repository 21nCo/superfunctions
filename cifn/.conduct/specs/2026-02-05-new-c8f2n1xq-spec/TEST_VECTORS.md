# CiFn Test Vectors

Golden inputs/outputs and negative variants. All JSON is canonical (no extra whitespace in examples where it matters for comparison).

---

## Pipeline (PIPE)

### TV-PIPE-001 Positive: Valid YAML pipeline accepted
- **Description**: Minimal valid YAML pipeline produces PipelineSpec with one job and one step.
- **Input**: YAML string or file:
```yaml
name: min
on:
  workflow_dispatch: {}
jobs:
  build:
    runs-on: default
    steps:
      - run: echo ok
```
- **Expected output**: Parse success; PipelineSpec with jobs.build, steps[0].run === "echo ok", runs-on === "default".
- **Negative**: N/A

### TV-PIPE-002 Positive: Valid JSON pipeline accepted
- **Description**: Same pipeline as JSON is accepted.
- **Input**: JSON `{"name":"min","on":{"workflow_dispatch":{}},"jobs":{"build":{"runs-on":"default","steps":[{"run":"echo ok"}]}}}`
- **Expected output**: Same PipelineSpec as TV-PIPE-001.
- **Negative**: N/A

### TV-PIPE-003 Positive: Valid config passes schema validation
- **Input**: Valid pipeline document (YAML or JSON) conforming to pipeline.schema.json.
- **Expected output**: Validation returns success; no errors.
- **Negative**: TV-PIPE-004

### TV-PIPE-004 Negative: Invalid config fails validation
- **Description**: Unknown top-level key or invalid job structure fails.
- **Input**: `{"name":"x","on":{},"jobs":{"build":{"runs-on":"default","steps":[{"uses":"unknown/action"}]}}}`
- **Expected output**: Validation fails; error code PIPELINE_INVALID; message or details indicate unknown uses.
- **Negative variant**: Invalid step type must yield PIPELINE_INVALID.

### TV-PIPE-005 Positive: All supported step types accepted
- **Input**: Pipeline with one step of each: run, uses: checkout, cache/restore, cache/save, artifact/upload, artifact/download, testfn/run, hostfn/deploy (can be in separate jobs).
- **Expected output**: Parse and validation success; each step type present in PipelineSpec.
- **Negative**: TV-PIPE-006

### TV-PIPE-006 Negative: Unknown uses rejected
- **Input**: Step `uses: notreal/action`.
- **Expected output**: Validation fails; PIPELINE_INVALID; unknown uses.
- **Negative variant**: Same for invalid with keys for a known uses.

### TV-PIPE-007 Positive: All trigger types parse
- **Input**: Pipeline with on.push.branches, on.pull_request.branches, on.schedule (cron), on.workflow_dispatch.
- **Expected output**: Parse success; trigger types stored in PipelineSpec.
- **Negative**: Invalid cron syntax may fail validation (schema or parser).

### TV-PIPE-008 Positive: Expression in if skips step when false
- **Input**: Run with trigger payload github.ref = refs/heads/feature; step with if: github.ref == 'refs/heads/main'.
- **Expected output**: Step status skipped; step not executed.
- **Negative**: When expression true, step runs (positive case for RUN-003).

### TV-PIPE-009 Negative: secrets.* never in logs
- **Input**: Job with env or step using ${{ secrets.MY_SECRET }}; MY_SECRET = "redact-me".
- **Expected output**: Log output (step stdout/stderr or API log response) does not contain "redact-me".
- **Negative variant**: If any log contains the secret value, test fails.

### TV-PIPE-010 Positive: Config path configurable
- **Input**: CLI invocation with --config /path/to/custom.yml or env CIFN_CONFIG=/path/to/custom.yml; file exists and is valid.
- **Expected output**: Pipeline loaded from custom path; run created or validated.
- **Negative**: Missing file returns error (file not found or PIPELINE_INVALID).

---

## API (API)

### TV-API-001 Positive: Success response envelope
- **Input**: GET /api/v1/runs with valid auth; at least one run exists.
- **Expected output**: HTTP 200; body `{"ok":true,"data":{"runs":[...],"nextCursor":null or string}}`.
- **Negative**: TV-API-002

### TV-API-002 Negative: Error response envelope
- **Input**: GET /api/v1/runs/invalid-run-id-99999.
- **Expected output**: HTTP 404; body `{"ok":false,"error":{"code":"RUN_NOT_FOUND","message":"...","details":{}}}`.
- **Negative variant**: 4xx/5xx always have ok: false and error.code.

### TV-API-003 Positive: POST /runs creates run
- **Input**: POST /api/v1/runs body `{"pipelineRef":{"repo":"https://github.com/org/repo","ref":"main"},"trigger":{"type":"workflow_dispatch"}}`; pipeline fetchable and valid.
- **Expected output**: HTTP 201; body `{"ok":true,"data":{"runId":"...","status":"queued","createdAt":"..."}}`; runId non-empty, createdAt ISO 8601.
- **Negative**: TV-API-004, TV-API-005

### TV-API-004 Negative: POST /runs invalid body
- **Input**: POST /api/v1/runs body `{}` or missing pipelineRef.
- **Expected output**: HTTP 400; error code BAD_REQUEST.
- **Negative variant**: Malformed JSON → 400.

### TV-API-005 Negative: POST /runs pipeline invalid
- **Input**: POST /api/v1/runs with pipelineRef that resolves to invalid pipeline (e.g. unknown uses).
- **Expected output**: HTTP 422; error code RUN_CREATE_FAILED or PIPELINE_INVALID.
- **Negative variant**: Pipeline fetch failure (e.g. 404 repo) → 422 or 400.

### TV-API-006 Positive: GET /runs with paging
- **Input**: GET /api/v1/runs?limit=2; at least 3 runs exist.
- **Expected output**: HTTP 200; data.runs length 2; data.nextCursor present if more results.
- **Negative**: TV-API-007 (limit > 100)

### TV-API-007 Negative: GET /runs limit over max
- **Input**: GET /api/v1/runs?limit=101.
- **Expected output**: HTTP 400 or 200 with limit capped to 100 (spec says max 100); if 400, BAD_REQUEST.
- **Negative variant**: Invalid cursor → 400.

### TV-API-008 Positive: GET /runs/:runId returns run
- **Input**: GET /api/v1/runs/:runId with valid runId.
- **Expected output**: HTTP 200; body ok: true, data has runId, status, jobs (array), createdAt, etc.; no secret in data.
- **Negative**: TV-API-009

### TV-API-009 Negative: GET /runs/:runId not found
- **Input**: GET /api/v1/runs/nonexistent-id.
- **Expected output**: HTTP 404; error code RUN_NOT_FOUND.
- **Negative variant**: Same for invalid runId format if validated.

### TV-API-010 Positive: POST cancel succeeds
- **Input**: POST /api/v1/runs/:runId/cancel; run status queued or running.
- **Expected output**: HTTP 200; data.status === "cancelled".
- **Negative**: TV-API-011

### TV-API-011 Negative: POST cancel already finished
- **Input**: POST /api/v1/runs/:runId/cancel; run status success or failure or cancelled.
- **Expected output**: HTTP 409; error code RUN_ALREADY_FINISHED.
- **Negative variant**: 404 when runId not found.

### TV-API-012 Positive: GET logs returns content
- **Input**: GET /api/v1/runs/:runId/jobs/build/logs; job has run and produced logs.
- **Expected output**: HTTP 200; body stream or JSON array of log lines; no secret value in lines.
- **Negative**: TV-API-013

### TV-API-013 Negative: GET logs not found
- **Input**: GET /api/v1/runs/:runId/jobs/nonexistent/logs.
- **Expected output**: HTTP 404.
- **Negative variant**: Invalid runId → 404.

### TV-API-014 Positive: GET artifacts returns list
- **Input**: GET /api/v1/runs/:runId/artifacts; run has at least one artifact uploaded.
- **Expected output**: HTTP 200; data.artifacts array with { name, fileId?, url? }; no secret in response.
- **Negative**: Run with no artifacts → data.artifacts = [].

---

## Runs, jobs, steps (RUN)

### TV-RUN-001 Positive: Run state machine
- **Input**: Create run; cancel run before any job completes.
- **Expected output**: Run status transitions queued → running (if job started) → cancelled; no transition from cancelled to any other.
- **Negative**: Attempt to "restart" cancelled run does not change status (or API rejects).

### TV-RUN-002 Positive: Job order respects needs
- **Input**: Pipeline with job A (no needs), job B (needs: [A]). Trigger run.
- **Expected output**: Job A runs first; job B starts only after A completes successfully (or skipped).
- **Negative**: TV-RUN-003

### TV-RUN-003 Negative: Cyclic needs rejected
- **Input**: Pipeline with job A needs [B], job B needs [A].
- **Expected output**: Validation fails; PIPELINE_INVALID or equivalent; no run created.
- **Negative variant**: needs depth > 10 rejected.

### TV-RUN-004 Positive: Step order and if
- **Input**: Job with steps [run: A, run: B with if: failure(), run: C]. Step A succeeds.
- **Expected output**: Step A runs; step B skipped (if false); step C runs. Order preserved.
- **Negative**: When A fails, B runs (if: failure() true).

### TV-RUN-005 Positive: Uniqueness of ids
- **Input**: Create two runs; list runs.
- **Expected output**: Two distinct runIds; each run has jobs with distinct jobKeys; steps have distinct identity within job.
- **Negative**: No duplicate runId in DB/API.

---

## Runners (RUNNER)

### TV-RUNNER-001 Positive: runs-on dispatch
- **Input**: Two jobs: one runs-on default, one runs-on hostfn-runner. Register one default runner and one hostfn-runner.
- **Expected output**: First job claimed by default runner; second by hostfn-runner when available.
- **Negative**: Job with unknown runs-on may queue until matching runner or fail (spec-defined).

### TV-RUNNER-002 Positive: Runner register valid token
- **Input**: POST /api/v1/runners/register with token valid in secfn.
- **Expected output**: HTTP 200; data.runnerId present.
- **Negative**: TV-RUNNER-003

### TV-RUNNER-003 Negative: Runner register invalid token
- **Input**: POST /api/v1/runners/register with invalid or expired token.
- **Expected output**: HTTP 401; error code RUNNER_TOKEN_INVALID.
- **Negative variant**: Missing token → 401.

### TV-RUNNER-004 Positive: Runner executes only job steps
- **Input**: Job with steps [run: echo 1, run: echo 2]. Runner claims job.
- **Expected output**: Runner runs only those two steps; no extra commands from control plane beyond step definitions.
- **Negative**: Payload must not contain arbitrary shell to eval.

### TV-RUNNER-005 Positive: Self-hosted with labels
- **Input**: Register runner with labels ["docker-ubuntu-22"]; create run with job runs-on: docker-ubuntu-22.
- **Expected output**: Job dispatched to that runner when labels match (if supported in v1).
- **Negative**: No matching runner → job stays queued or fails per spec.

### TV-RUNNER-006 Positive: hostfn-runner and --local
- **Input**: Job runs-on hostfn-runner, step hostfn/deploy with environment production; runner on same node as target.
- **Expected output**: hostfn deploy production --local --ci executed; deploy succeeds (given hostfn and env).
- **Negative**: Runner not on target → may use SSH path (hostfn without --local).

---

## Security (SEC)

### TV-SEC-001 Negative: API unauthenticated
- **Input**: GET /api/v1/runs without Authorization header or invalid token.
- **Expected output**: HTTP 401.
- **Negative variant**: Invalid bearer token → 401.

### TV-SEC-002 Positive: API authenticated
- **Input**: GET /api/v1/runs with valid API key or bearer token.
- **Expected output**: HTTP 200; data as per TV-API-001.
- **Negative**: N/A

### TV-SEC-003 Positive: No secret in response or logs
- **Input**: Run job that uses secrets.MY_KEY; fetch run detail and job logs.
- **Expected output**: Response body and log content do not contain the value of MY_KEY.
- **Negative**: If value appears, test fails.

### TV-SEC-004 Negative: Unverified webhook
- **Input**: POST webhook endpoint with invalid or missing signature.
- **Expected output**: Run not created; HTTP 401 or 403.
- **Negative variant**: Valid signature creates run (positive).

### TV-SEC-005 Positive: Secrets from secfn
- **Input**: Configure CiFn with secfn for runner token and API key; start control plane.
- **Expected output**: No hardcoded secrets in config file; runner register and API auth work using secfn-backed values.
- **Negative**: Operational check; no negative vector required.

---

## Integrations (INT)

### TV-INT-001 Positive: flowfn enqueue and dequeue
- **Input**: Create run; ensure flowfn queue has job(s); runner heartbeat.
- **Expected output**: Root job(s) appear in flowfn; runner receives job from flowfn (or control plane via flowfn).
- **Negative**: Without flowfn, run create may fail or queue locally (spec may allow in-memory for tests).

### TV-INT-002 Positive: Artifact in filefn
- **Input**: Run job with artifact/upload step (name: out, path: dist/); then GET /runs/:runId/artifacts.
- **Expected output**: data.artifacts includes { name: "out", fileId or url }; filefn contains object for that run/artifact.
- **Negative**: Download step in later job can read artifact.

### TV-INT-003 Positive: Cache restore/save
- **Input**: Job with cache/save key: deps-1 paths: [node_modules]; then another run with cache/restore key: deps-1.
- **Expected output**: Restore populates workspace when key exists (cachefn or filefn); save stores under key.
- **Negative**: Restore with missing key does not fail step (cache miss).

### TV-INT-004 Positive: testfn step runs tests
- **Input**: Job with uses: testfn/run with config and reporter; workspace has test file and testfn config.
- **Expected output**: testfn SDK invoked; test results (pass/fail) reported; step status success or failure accordingly.
- **Negative**: Test failure → step failure.

### TV-INT-005 Positive: Checkout at ref
- **Input**: Trigger with ref main; pipelineRef repo + ref; checkout step.
- **Expected output**: Workspace contains repo at ref main; subsequent step sees correct files.
- **Negative**: Invalid ref or inaccessible repo → step failure or run failure.

### TV-INT-006 Positive: hostfn deploy step
- **Input**: Job with hostfn/deploy environment: production, ci: true; env HOSTFN_SSH_KEY from secfn.
- **Expected output**: hostfn CLI executed with deploy production --ci; HOSTFN_SSH_KEY set in env (value from secfn).
- **Negative**: Missing secret → step fails or hostfn fails.

---

## CLI (CLI)

### TV-CLI-001 Positive: cifn run creates run
- **Input**: Valid pipeline in .ci/pipeline.yml; cifn run (API available and auth configured).
- **Expected output**: Exit 0; run created; runId printed or in output.
- **Negative**: TV-CLI-002

### TV-CLI-002 Negative: cifn run invalid pipeline
- **Input**: Invalid pipeline (e.g. unknown uses); cifn run.
- **Expected output**: Exit non-zero; error message; no run created.
- **Negative variant**: No secret in stderr.

### TV-CLI-003 Positive: cifn status list and detail
- **Input**: cifn status → then cifn status &lt;runId&gt;.
- **Expected output**: First call lists runs; second shows run detail; --format json yields valid JSON.
- **Negative**: cifn status invalid-runId → error exit.

### TV-CLI-004 Positive: cifn logs no secret
- **Input**: Run that logged a secret in step script (e.g. echo $SECRET); cifn logs runId jobKey.
- **Expected output**: Log output redacted or secret not present.
- **Negative**: If secret visible, test fails.

---

## Observability (OBS)

### TV-OBS-001 Positive: Events logged
- **Input**: Create run; run one job to completion.
- **Expected output**: Log stream contains run created, job started, step started, step completed, job completed (or equivalent); no secret in log lines.
- **Negative**: N/A

### TV-OBS-002 Negative: Secret never in log
- **Input**: Step that echoes ${{ secrets.X }}; X = "secret123".
- **Expected output**: Log content does not contain "secret123".
- **Negative variant**: Same as TV-PIPE-009 / TV-SEC-003.

### TV-OBS-003 Positive: Metrics without PII
- **Input**: When watchfn integrated, emit run_duration, job_duration.
- **Expected output**: Metric labels do not include runId that is considered PII if policy says so; or runId allowed; no secret in labels.
- **Negative**: Spec says MUST NOT include PII/secrets; test asserts that.

---

## Limits (LIMIT)

### TV-LIMIT-001 Negative: Pipeline document too large
- **Input**: Pipeline document &gt; 500 KB.
- **Expected output**: Validation or parse fails; error indicates size or PIPELINE_INVALID.
- **Negative variant**: Exactly 500 KB acceptable.

### TV-LIMIT-002 Negative: Jobs or steps over limit
- **Input**: Pipeline with 101 jobs or job with 101 steps or needs depth 11.
- **Expected output**: Validation fails; PIPELINE_INVALID or equivalent.
- **Negative variant**: 100 jobs / 100 steps / depth 10 accepted.

### TV-LIMIT-003 Negative: GET /runs limit > 100
- **Input**: GET /api/v1/runs?limit=101.
- **Expected output**: 400 BAD_REQUEST or response with limit capped to 100 (implementation choice).
- **Negative variant**: limit=100 accepted.

### TV-LIMIT-004 Positive: Parse performance
- **Input**: Valid pipeline ~100 KB; parse + validate.
- **Expected output**: Completes in &lt; 500ms (best effort in v1).
- **Negative**: Not required to fail if slower; benchmark only.

---

## Dashboard (DASH)

### TV-DASH-001 Positive: Dashboard shows run list and detail
- **Input**: Open dashboard; authenticate; list runs; open one run.
- **Expected output**: Run list rendered; run detail shows jobs, steps, link to logs; artifact list visible; auth required.
- **Negative**: Unauthenticated redirect or 401.

### TV-DASH-002 Positive: sendfn notification when configured
- **Input**: Configure sendfn for run failure; trigger run that fails.
- **Expected output**: Notification sent via sendfn (e.g. email or webhook).
- **Negative**: When not configured, no notification (no failure).
