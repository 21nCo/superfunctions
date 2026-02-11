# CiFn Test Vectors (audit-fix)

Golden inputs/outputs plus negative variants. Vectors are designed to be deterministic; where IDs/timestamps are generated, expected output uses constraints (e.g., “non-empty string”).

---

## Pipeline (PIPE)

### TV-PIPE-001 Positive: Valid YAML pipeline accepted
- **Description**: Minimal YAML pipeline parses and validates.
- **Input** (YAML):
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
- **Expected output**:
  - Parse succeeds.
  - Validation succeeds.
  - Canonical PipelineSpec contains job `build` with step[0].run = `echo ok`.
- **Negative variant(s)**: See TV-PIPE-002, TV-PIPE-003.

### TV-PIPE-002 Negative: Invalid YAML rejected
- **Description**: YAML syntax error fails with PIPELINE_INVALID.
- **Input**:
```yaml
name: bad
on:
  workflow_dispatch: {}
jobs:
  build:
    runs-on: default
    steps:
      - run echo oops   # invalid
```
- **Expected output**:
  - Parse fails.
  - Error code: `PIPELINE_INVALID`.
- **Negative variant(s)**:
  - Empty document fails with `PIPELINE_INVALID`.

### TV-PIPE-003 Negative: Invalid JSON rejected
- **Description**: Malformed JSON fails with PIPELINE_INVALID.
- **Input**: JSON string `{"name":"x","on":{"workflow_dispatch":{}},"jobs":`
- **Expected output**:
  - Parse fails.
  - Error code: `PIPELINE_INVALID`.
- **Negative variant(s)**:
  - Valid JSON with wrong top-level types is covered by schema tests (TV-PIPE-005).

### TV-PIPE-004 Positive: Valid config passes schema validation
- **Input**: A valid pipeline document (e.g., TV-PIPE-001).
- **Expected output**:
  - Ajv schema validation passes with no errors.
- **Negative variant(s)**: TV-PIPE-005.

### TV-PIPE-005 Negative: Unknown keys/types fail schema validation
- **Input** (JSON):
```json
{
  "name": "x",
  "on": { "workflow_dispatch": {} },
  "env": { "A": "1" },
  "unknownTopLevelKey": true,
  "jobs": {
    "build": {
      "runs-on": "default",
      "steps": [ { "run": "echo ok" } ]
    }
  }
}
```
- **Expected output**:
  - Validation fails.
  - Error code: `PIPELINE_INVALID`.
- **Negative variant(s)**:
  - `jobs.build.steps` not an array fails with `PIPELINE_INVALID`.

### TV-PIPE-006 Positive: All supported step types accepted
- **Input** (YAML):
```yaml
name: steps
on:
  workflow_dispatch: {}
jobs:
  build:
    runs-on: default
    steps:
      - uses: checkout
      - uses: cache/restore
        with: { key: deps-abc, paths: node_modules }
      - run: npm ci
      - uses: cache/save
        with: { key: deps-abc, paths: node_modules }
      - uses: artifact/upload
        with: { name: dist, path: dist/ }
      - uses: artifact/download
        with: { name: dist, path: dist/ }
      - uses: testfn/run
        with: { framework: vitest, testPattern: "./tests/**/*.test.ts", reporter: json }
      - uses: hostfn/deploy
        with: { environment: production, ci: true }
```
- **Expected output**:
  - Parse + validation succeed.
  - Steps are preserved in the canonical spec.
- **Negative variant(s)**: TV-PIPE-007, TV-PIPE-014..016.

### TV-PIPE-007 Negative: Unknown `uses` rejected
- **Input** (YAML):
```yaml
name: bad-uses
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: default
    steps:
      - uses: notreal/action
```
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-PIPE-008 Positive: Trigger shapes parse
- **Input** (YAML):
```yaml
name: triggers
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch: {}
jobs:
  build:
    runs-on: default
    steps: [ { run: "echo ok" } ]
```
- **Expected output**:
  - Parse + validation succeed.
  - Trigger types are preserved in canonical spec.
- **Negative variant(s)**: TV-PIPE-009, TV-PIPE-012.

### TV-PIPE-009 Negative: Invalid trigger shape rejected
- **Input**: `on.workflow_dispatch: true` (invalid type).
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-PIPE-010 Positive: schedule array accepted
- **Input**:
```yaml
name: sched-array
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  build: { runs-on: default, steps: [ { run: "echo ok" } ] }
```
- **Expected output**:
  - Canonical PipelineSpec stores `on.schedule` as an array with length 1.
- **Negative variant(s)**: TV-PIPE-012.

### TV-PIPE-011 Positive: schedule object accepted and normalized
- **Input**:
```yaml
name: sched-obj
on:
  schedule:
    cron: "0 2 * * *"
jobs:
  build: { runs-on: default, steps: [ { run: "echo ok" } ] }
```
- **Expected output**:
  - Canonical PipelineSpec stores `on.schedule` as an array with length 1.
  - The single entry has `cron: "0 2 * * *"`.
- **Negative variant(s)**: TV-PIPE-012.

### TV-PIPE-012 Negative: Invalid cron rejected
- **Input**: `on.schedule: [{ cron: "not-a-cron" }]`
- **Expected output**:
  - Validation (schema or semantic) fails with `PIPELINE_INVALID`.

### TV-PIPE-013 Negative: Cyclic needs rejected
- **Input**:
```yaml
name: cycle
on: { workflow_dispatch: {} }
jobs:
  a:
    runs-on: default
    needs: [b]
    steps: [ { run: "echo a" } ]
  b:
    runs-on: default
    needs: [a]
    steps: [ { run: "echo b" } ]
```
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-PIPE-014 Negative: Unknown `with` key rejected for known action
- **Input**:
```yaml
name: bad-with
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: default
    steps:
      - uses: artifact/upload
        with:
          name: dist
          path: dist/
          unexpected: true
```
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-PIPE-015 Negative: Missing required `with` fields rejected
- **Input**:
```yaml
name: bad-with2
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: default
    steps:
      - uses: artifact/upload
        with:
          name: dist
```
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID` (missing `path`).

### TV-PIPE-016 Positive: Valid `with` shapes accepted
- **Input**: Same pipeline as TV-PIPE-006.
- **Expected output**:
  - Validation succeeds; semantic validation recognizes required keys.
- **Negative variant(s)**: TV-PIPE-014, TV-PIPE-015.

---

## API (API)

### TV-API-001 Positive: Create run via pipelineRef succeeds
- **Input**: HTTP `POST /api/v1/runs` body:
```json
{
  "pipelineRef": { "repo": "https://github.com/org/repo", "ref": "main" },
  "trigger": { "type": "workflow_dispatch", "payload": {} }
}
```
- **Expected output**:
  - HTTP 201
  - Body:
```json
{ "ok": true, "data": { "runId": "<non-empty>", "status": "queued", "createdAt": "<iso8601>" } }
```
- **Negative variant(s)**: TV-API-004, TV-API-005.

### TV-API-002 Positive: Create run via inline pipelineSpec succeeds
- **Input**: HTTP `POST /api/v1/runs` body:
```json
{
  "pipelineSpec": {
    "name": "inline",
    "on": { "workflow_dispatch": {} },
    "jobs": { "build": { "runs-on": "default", "steps": [ { "run": "echo ok" } ] } }
  },
  "trigger": { "type": "workflow_dispatch", "payload": {} }
}
```
- **Expected output**: Same shape as TV-API-001 (201 with runId).
- **Negative variant(s)**: TV-API-003, TV-PIPE-005.

### TV-API-003 Negative: Create run missing pipelineRef/pipelineSpec
- **Input**: HTTP `POST /api/v1/runs` body:
```json
{ "trigger": { "type": "workflow_dispatch", "payload": {} } }
```
- **Expected output**:
  - HTTP 400
  - Body:
```json
{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "<string>" } }
```

### TV-API-004 Negative: pipelineRef configPath missing
- **Input**: `POST /api/v1/runs` where configPath points to missing file:
```json
{
  "pipelineRef": { "repo": "https://github.com/org/repo", "ref": "main", "configPath": ".ci/does-not-exist.yml" },
  "trigger": { "type": "workflow_dispatch", "payload": {} }
}
```
- **Expected output**:
  - HTTP 422
  - Error code `RUN_CREATE_FAILED`.

### TV-API-005 Negative: pipelineRef resolves invalid pipeline
- **Input**: pipelineRef points to a config containing invalid step uses.
- **Expected output**:
  - HTTP 422
  - Error code `PIPELINE_INVALID`.

### TV-API-006 Positive: Success envelope shape
- **Input**: `GET /api/v1/runs` with valid auth.
- **Expected output**:
  - HTTP 200
  - Body:
```json
{ "ok": true, "data": { "runs": [], "nextCursor": null } }
```
- **Negative variant(s)**: TV-API-007.

### TV-API-007 Negative: Error envelope + code set constrained
- **Input**: `GET /api/v1/runs/nonexistent-run-id`
- **Expected output**:
  - HTTP 404
  - `ok:false`
  - `error.code` is one of the canonical codes (here: `RUN_NOT_FOUND`).
- **Negative variant(s)**:
  - Any response returning `error.code` not in canonical set is a failure.

### TV-API-008 Positive: List runs paging
- **Input**: `GET /api/v1/runs?limit=2` with at least 3 runs in store.
- **Expected output**:
  - `data.runs.length === 2`
  - `data.nextCursor` is a non-empty string.
- **Negative variant(s)**: TV-API-009, TV-API-010.

### TV-API-009 Negative: Invalid cursor rejected
- **Input**: `GET /api/v1/runs?cursor=not-a-real-cursor`
- **Expected output**:
  - HTTP 400
  - `error.code === "BAD_REQUEST"`.

### TV-API-010 Negative: limit over max rejected (or capped deterministically)
- **Input**: `GET /api/v1/runs?limit=101`
- **Expected output** (choose one behavior and keep consistent):
  - HTTP 400 with `BAD_REQUEST`, OR
  - HTTP 200 with limit capped to 100.
- **Negative variant(s)**:
  - If behavior differs across requests, it fails determinism.

### TV-API-011 Positive: Get run detail returns canonical identifiers
- **Input**: `GET /api/v1/runs/<existingRunId>`
- **Expected output**:
  - HTTP 200 with `ok:true`
  - `data.runId === <requestedRunId>`
  - Jobs are keyed by `jobKey` and steps have stable identity fields.
- **Negative variant(s)**: TV-API-012.

### TV-API-012 Negative: Get run detail not found
- **Input**: `GET /api/v1/runs/does-not-exist`
- **Expected output**:
  - HTTP 404
  - `error.code === "RUN_NOT_FOUND"`.

### TV-API-013 Positive: Cancel queued/running run
- **Input**: `POST /api/v1/runs/<queuedRunId>/cancel`
- **Expected output**:
  - HTTP 200
  - `data.status === "cancelled"`.
- **Negative variant(s)**: TV-API-014.

### TV-API-014 Negative: Cancel terminal run rejected
- **Input**: cancel a run that is already success or failure.
- **Expected output**:
  - HTTP 409
  - `error.code === "RUN_ALREADY_FINISHED"`.

### TV-API-015 Positive: Logs returned and redacted
- **Input**: `GET /api/v1/runs/<runId>/jobs/build/logs`
- **Expected output**:
  - HTTP 200
  - `data.lines` is an array of strings
  - Does not contain any known secret values.
- **Negative variant(s)**: TV-SEC-001.

### TV-API-016 Positive: Artifacts returned
- **Input**: `GET /api/v1/runs/<runId>/artifacts`
- **Expected output**:
  - HTTP 200
  - `data.artifacts` is an array of `{name,fileId?,url?}`.
- **Negative variant(s)**:
  - Run with no artifacts returns `[]` deterministically.

### TV-API-017 Negative: Artifacts for missing run rejected
- **Input**: `GET /api/v1/runs/does-not-exist/artifacts`
- **Expected output**:
  - HTTP 404
  - `error.code === "RUN_NOT_FOUND"`.

---

## Expressions / conditions / interpolation (EXPR)

### TV-EXPR-001 Positive: failure() step runs after failure; default steps skip
- **Input** (pipelineSpec via API-002):
```json
{
  "pipelineSpec": {
    "name": "if",
    "on": { "workflow_dispatch": {} },
    "jobs": {
      "build": {
        "runs-on": "default",
        "steps": [
          { "run": "node -e \"process.exit(1)\"" },
          { "uses": "artifact/upload", "if": "failure()", "with": { "name": "fail-info", "path": "./" } },
          { "run": "echo should-skip-by-default" }
        ]
      }
    }
  },
  "trigger": { "type": "workflow_dispatch", "payload": { "github": { "ref": "refs/heads/main" } } }
}
```
- **Expected output**:
  - Step 0 status `failure`
  - Step 1 status `success` (ran because `failure()` true)
  - Step 2 status `skipped` (default condition `success()` false)
  - Job status `failure`
- **Negative variant(s)**:
  - If the runner stops immediately after step 0 failure and marks step 1 skipped, the test fails.

### TV-EXPR-002 Positive: Job if false => skipped and satisfies needs
- **Input**:
```json
{
  "pipelineSpec": {
    "name": "job-if",
    "on": { "workflow_dispatch": {} },
    "jobs": {
      "a": { "runs-on": "default", "if": "github.ref == 'refs/heads/nope'", "steps": [ { "run": "echo a" } ] },
      "b": { "runs-on": "default", "needs": ["a"], "steps": [ { "run": "echo b" } ] }
    }
  },
  "trigger": { "type": "workflow_dispatch", "payload": { "github": { "ref": "refs/heads/main" } } }
}
```
- **Expected output**:
  - Job `a` status `skipped`
  - Job `b` runs and succeeds (needs satisfied by skipped)
- **Negative variant(s)**:
  - If job `b` never runs because `a` skipped, the test fails.

### TV-EXPR-003 Positive: secrets interpolation works and remains redacted
- **Input**:
  - secfn contains `MY_SECRET = "redact-me"`
  - Pipeline uses `env: { X: "${{ secrets.MY_SECRET }}" }` and a step `run: "echo $X"`.
- **Expected output**:
  - Step runs successfully.
  - Logs do not contain `redact-me` (they contain `***` or nothing).
- **Negative variant(s)**:
  - If logs contain `redact-me`, the test fails.

### TV-EXPR-004 Positive: Branch gating works with github.ref
- **Input**: job `deploy` has `if: github.ref == 'refs/heads/main'` and trigger ref is `refs/heads/feature`.
- **Expected output**:
  - deploy job status `skipped`.
- **Negative variant(s)**:
  - With trigger ref `refs/heads/main`, deploy job runs.

### TV-EXPR-005 Positive: `${{ github.ref }}` interpolation in strings
- **Input**: step `run: "echo ref=${{ github.ref }}"` with trigger ref `refs/heads/main`.
- **Expected output**:
  - The executed command contains `ref=refs/heads/main` (or output does).
- **Negative variant(s)**:
  - Unknown github field causes `PIPELINE_INVALID` (TV-EXPR-006).

### TV-EXPR-006 Negative: Unsupported expression syntax rejected
- **Input**: `if: github.ref =~ 'main'` (unsupported operator).
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-EXPR-007 Positive: hashFiles is deterministic and affects cache key
- **Input**:
  - Workspace contains file `package-lock.json` with known contents `"abc\n"`.
  - Cache key is `deps-${{ hashFiles('package-lock.json') }}`.
- **Expected output**:
  - `hashFiles('package-lock.json')` returns the same lowercase hex hash for the same file contents.
  - Changing the file contents changes the hash (and thus key).
- **Negative variant(s)**:
  - If glob matches no files, hash is deterministic (hash of empty string).

### TV-EXPR-008 Negative: Expression length cap enforced
- **Input**: `if` string length 2049 chars.
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

---

## Runs / jobs / steps (RUN)

### TV-RUN-001 Positive: Job order respects needs
- **Input**: Pipeline with job `a` then job `b` with `needs: [a]`.
- **Expected output**:
  - Job `a` runs before `b`.
  - Job `b` starts only after `a` is `success` or `skipped`.
- **Negative variant(s)**: TV-PIPE-013 (cycle rejected).

### TV-RUN-002 Positive: Status enums consistent
- **Input**: A run that includes a skipped job/step (via `if`) and a failed job.
- **Expected output**:
  - Status values are only from the allowed sets.
- **Negative variant(s)**:
  - Any unknown status value is a failure.

### TV-RUN-003 Positive: Dependent job skipped on failed need
- **Input**: Pipeline where `build` fails; `deploy` needs build.
- **Expected output**:
  - build job status `failure`
  - deploy job status `skipped`
- **Negative variant(s)**:
  - If deploy runs, test fails.

### TV-RUN-004 Positive: Step ordering preserved (including skipped)
- **Input**: Job with three steps where middle step is skipped by `if`.
- **Expected output**:
  - Step indices preserve config order; middle step is skipped; third step still reports correct index.

### TV-RUN-005 Positive: Artifacts upload then download restores bytes
- **Input**:
  - build job creates `dist/out.txt` with contents `hello`.
  - upload artifact `dist` from `dist/`.
  - later job downloads `dist` and checks file contents.
- **Expected output**:
  - Downloaded `dist/out.txt` is `hello`.
- **Negative variant(s)**:
  - Downloading missing artifact name fails deterministically (error code or step failure).

### TV-RUN-006 Positive: Cache save/restore hits by key
- **Input**:
  - First run saves cache key `deps-<hash>` with `node_modules/marker.txt`.
  - Second run restores same key and verifies marker exists.
- **Expected output**:
  - Restore step reports hit and marker exists.
- **Negative variant(s)**:
  - Different key yields miss and marker absent.

### TV-RUN-007 Positive/Negative: Private checkout token never leaks
- **Input**:
  - checkout step uses a token value `ghp_exampletoken`.
  - force a git error that would normally print URL/token (e.g., invalid token).
- **Expected output**:
  - Step fails, but logs do not contain `ghp_exampletoken`.
- **Negative variant(s)**:
  - If logs contain the token, the test fails (SEC-001/OBS-003).

---

## Runners (RUNNER)

### TV-RUNNER-001 Positive: runs-on dispatch
- **Input**:
  - Register runner A labels: `["default"]`
  - Register runner B labels: `["hostfn-runner"]`
  - Create run with two jobs: one runs-on default, one runs-on hostfn-runner.
- **Expected output**:
  - default job claimed by runner A; hostfn job claimed by runner B.
- **Negative variant(s)**:
  - If only default runner exists, hostfn job remains queued (does not run on default).

### TV-RUNNER-002 Positive: hostfn-runner deploy uses --local --ci
- **Input**: Job runs-on hostfn-runner with step `uses: hostfn/deploy` environment production.
- **Expected output**:
  - Invocation includes `hostfn deploy production --local --ci` (or equivalent flags).
- **Negative variant(s)**:
  - If runs-on is default, `--local` is not required but `--ci` is required.

### TV-RUNNER-003 Positive: Runner register returns runnerSecret once
- **Input**: `POST /api/v1/runners/register` with valid registration token.
- **Expected output**:
  - Response contains `runnerId` and `runnerSecret`.
  - Subsequent API calls to fetch runner details (if any) never reveal runnerSecret.
- **Negative variant(s)**:
  - Any endpoint that returns runnerSecret after registration is a failure.

### TV-RUNNER-004 Negative: Heartbeat using registration token rejected
- **Input**: `POST /api/v1/runners/heartbeat` with `Authorization: Bearer <registrationToken>`
- **Expected output**:
  - HTTP 401 `UNAUTHORIZED`.

### TV-RUNNER-005 Negative: Heartbeat with wrong runnerSecret rejected
- **Input**: heartbeat runnerId A with runnerSecret from runnerId B.
- **Expected output**:
  - HTTP 401 `UNAUTHORIZED`.

### TV-RUNNER-006 Positive: Heartbeat no job returns job:null envelope
- **Input**: heartbeat with valid runnerSecret when queue empty.
- **Expected output**:
```json
{ "ok": true, "data": { "job": null } }
```
- **Negative variant(s)**:
  - Any 204 response is a failure (API-011).

### TV-RUNNER-007 Negative: Unknown step shape fails safely
- **Input**: Job payload contains a step object that is neither run nor uses.
- **Expected output**:
  - Runner marks step/job as failure with a defined error message.
  - Runner does not execute arbitrary code.

### TV-RUNNER-008 Positive: job.image executes in Docker
- **Input**: job with `image: node:20` and step `run: node -v`.
- **Expected output**:
  - Step runs inside container (observable via log evidence, e.g. container environment).
- **Negative variant(s)**:
  - If docker unavailable, job fails deterministically with clear error (implementation-defined code/message).

---

## Security (SEC)

### TV-SEC-001 Negative: Secret never appears in logs
- **Input**:
  - secfn `MY_SECRET = "redact-me"`
  - job step runs `echo redact-me` (direct) or `echo ${{ secrets.MY_SECRET }}`
  - fetch logs via API
- **Expected output**:
  - Logs do NOT contain `redact-me`.
  - Redacted output is `***` or omitted.

### TV-SEC-002 Negative: Missing API auth rejected
- **Input**: `GET /api/v1/runs` with no auth headers.
- **Expected output**:
  - HTTP 401
  - `error.code === "UNAUTHORIZED"`.

### TV-SEC-003 Positive: Valid API auth accepted (single-tenant)
- **Input**:
  - `GET /api/v1/runs` with valid API key A
  - `GET /api/v1/runs` with valid API key B
- **Expected output**:
  - Both succeed and can read the same run IDs (single-tenant).
- **Negative variant(s)**:
  - Invalid key returns UNAUTHORIZED (TV-SEC-002).

### TV-SEC-004 Positive: No plaintext secrets in API responses/store views
- **Input**:
  - Create run that references `${{ secrets.MY_SECRET }}`
  - Fetch run detail via API
- **Expected output**:
  - Response does not include `redact-me` or any secret values.

### TV-SEC-005 Negative/Positive: Webhook signature verification
- **Input (negative)**: `POST /webhooks/github` with invalid signature header.
- **Expected output (negative)**:
  - HTTP 401/403 (implementation-defined)
  - No run created.
- **Input (positive)**: Same payload with valid signature.
- **Expected output (positive)**:
  - Run created via pipelineRef.

### TV-SEC-006 Positive: Runner secret stored hashed (unit-level)
- **Input**: Register runner; inspect storage layer in a unit test.
- **Expected output**:
  - Stored secret is not equal to plaintext runnerSecret and is verified by hash compare.
- **Negative variant(s)**:
  - Any persisted plaintext runnerSecret fails.

---

## Integrations (INT)

### TV-INT-001 Positive: flowfn adapter dispatch works
- **Input**:
  - Configure control plane with real flowfn adapter (or flowfn-compatible in-process adapter).
  - Create a run with one job.
  - Runner heartbeat claims job.
- **Expected output**:
  - Job is enqueued via adapter and can be claimed.
- **Negative variant(s)**:
  - Misconfigured adapter yields clear startup error (not silent fallback).

### TV-INT-002 Positive: filefn-backed artifacts work
- **Input**:
  - Configure filefn adapter in “production mode”.
  - Upload artifact and list artifacts.
- **Expected output**:
  - API returns artifact with `fileId` and/or `url`.
- **Negative variant(s)**:
  - Filefn unavailable => step fails deterministically and does not corrupt run state.

### TV-INT-003 Positive: secfn adapter resolves secrets
- **Input**:
  - Configure secfn adapter to provide API keys, runner token, and a job secret.
  - Run pipeline that references `${{ secrets.MY_SECRET }}`.
- **Expected output**:
  - Run succeeds (or fails for unrelated reasons) and secret is injected.
- **Negative variant(s)**:
  - Missing secret key yields deterministic step/job failure without leaking secret names as values.

### TV-INT-004 Positive: logfn events exist and logs endpoint returns them
- **Input**: Run a pipeline and fetch logs.
- **Expected output**:
  - Lifecycle events are present (run/job/step start/complete).
  - logs endpoint returns redacted lines.

### TV-INT-005 Positive: webhook trigger creates run via pipelineRef
- **Input**: Verified webhook payload representing a push to `refs/heads/main`.
- **Expected output**:
  - Run created using pipelineRef resolved from repo/ref/configPath.
- **Negative variant(s)**: TV-SEC-005 negative case.

### TV-INT-006 Positive: testfn/run uses SDK and produces JSON report
- **Input**: Pipeline with step:
```yaml
- uses: testfn/run
  with:
    framework: vitest
    testPattern: "./tests/**/*.test.ts"
    reporter: json
    outputPath: "./testfn-results.json"
```
- **Expected output**:
  - Step runs using testfn SDK (observable via code-path unit test or logs).
  - A JSON report exists at outputPath and can be uploaded as artifact.
- **Negative variant(s)**:
  - Invalid framework yields deterministic failure without crashing.

### TV-INT-007 Positive: hostfn/deploy invocation flags
- **Input**:
  - `uses: hostfn/deploy` with `environment: production` and `ci: true`
- **Expected output**:
  - hostfn CLI invoked with `deploy production --ci` and includes secrets via env.
- **Negative variant(s)**:
  - Missing required environment yields validation failure (PIPE-011/TV-PIPE-015).

### TV-INT-008 Positive: Hybrid trigger mode (external CI triggers CiFn)
- **Input (example; manual)**: A GitHub Actions workflow step that triggers CiFn via API:
```yaml
- name: Trigger CiFn run
  run: |
    curl -sS -X POST "$CIFN_BASE_URL/api/v1/runs" \
      -H "Authorization: Bearer $CIFN_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"pipelineRef":{"repo":"https://github.com/org/repo","ref":"main"},"trigger":{"type":"workflow_dispatch","payload":{"source":"gha"}}}'
```
- **Expected output**:
  - HTTP 201 with `{ok:true,data:{runId,...}}`.
  - Run appears in `GET /api/v1/runs`, with logs/artifacts available as usual.
- **Negative variant(s)**: TV-INT-008N.

### TV-INT-008N Negative: Hybrid trigger without auth is rejected
- **Input**: Same request as TV-INT-008 but without auth header.
- **Expected output**:
  - HTTP 401 with `error.code === "UNAUTHORIZED"`.

---

## Observability (OBS)

### TV-OBS-001 Positive: lifecycle events emitted
- **Input**: Run a pipeline with 1 job and 2 steps (1 success, 1 skipped).
- **Expected output**:
  - log stream includes `run.created`, `job.started`, `step.started`, `step.completed`, `job.completed`, `run.status_changed`.
- **Negative variant(s)**:
  - Missing required fields like runId/jobKey in events fails.

### TV-OBS-002 Positive: watchfn metrics emitted when enabled
- **Input**: Enable watchfn integration and run a pipeline.
- **Expected output**:
  - Metrics emitted (implementation-defined names) include run duration and status.
- **Negative variant(s)**: TV-OBS-002N.

### TV-OBS-002N Negative: watchfn disabled does not break runs
- **Input**: Disable watchfn integration and run same pipeline.
- **Expected output**:
  - Run still completes successfully; no watchfn calls are required.

### TV-OBS-003 Negative: checkout token is redacted
- **Input**: Force checkout to print token in stderr (simulated in unit test).
- **Expected output**:
  - Reported logs do not contain token.

---

## CLI (CLI)

### TV-CLI-001 Positive: `cifn run` remote creates run
- **Input**:
  - Local config at `.ci/pipeline.yml` (valid).
  - Run `cifn run` with control plane URL configured.
- **Expected output**:
  - CLI exits 0 and prints runId.
- **Negative variant(s)**: TV-CLI-002.

### TV-CLI-002 Negative: Missing config file fails
- **Input**: Run `cifn run --config ./does-not-exist.yml`
- **Expected output**:
  - CLI exits non-zero with a clear error.

### TV-CLI-003 Positive: `cifn run --local` executes locally
- **Input**: Run `cifn run --local` on a pipeline that contains `if` semantics (TV-EXPR-001).
- **Expected output**:
  - CLI exits non-zero when job fails, but still runs `failure()` steps as specified.

### TV-CLI-004 Positive: `cifn status` lists and shows detail
- **Input**:
  - `cifn status` (no args)
  - `cifn status <runId>`
- **Expected output**:
  - First prints list including runId.
  - Second prints detail including runId and job statuses.

### TV-CLI-005 Negative: `cifn logs` never prints secret values
- **Input**: Fetch logs for a job that attempted to print `redact-me`.
- **Expected output**:
  - CLI output does not contain `redact-me`.

### TV-CLI-006 Positive: CLI supports custom URL + credentials config
- **Input**: Set env/config for base URL and API key, then run `cifn status`.
- **Expected output**:
  - CLI uses configured endpoint and succeeds.

---

## Dashboard (DASH)

### TV-DASH-001 Positive: Run list/detail uses runId
- **Input (manual)**:
  - Start dashboard.
  - Load run list page.
  - Click a run entry.
- **Expected output**:
  - Run list renders.
  - Navigation uses `runId` in route/state.
  - Run detail loads and renders.

### TV-DASH-001N Negative: Dashboard does not depend on `run.id`
- **Input (test-level)**: Mock `GET /api/v1/runs` to return run objects that include `runId` but do not include `id`.
- **Expected output**:
  - Run list renders without runtime errors.
  - Clicking a run uses `runId` to navigate/load details.

### TV-DASH-002 Positive: sendfn notification on failure (when enabled)
- **Input**: Enable sendfn integration and run a pipeline that fails.
- **Expected output**:
  - A notification event is emitted via sendfn client.
- **Negative variant(s)**: TV-DASH-002N.

### TV-DASH-002N Negative: sendfn disabled does not break runs
- **Input**: Disable sendfn and run failing pipeline.
- **Expected output**:
  - Run still completes; no sendfn calls required.

---

## Self-deployability (DEPLOY)

### TV-DEPLOY-001 Positive: Docker Compose boots control plane + runner
- **Input (manual)**:
  - From `cifn/` deployment folder, run `docker compose up`.
  - Call `/health` and `GET /api/v1/runs` with valid API key.
- **Expected output**:
  - Control plane responds.
  - Runner registers/heartbeats successfully.

### TV-DEPLOY-002 Positive: hostfn deploys control plane + runner
- **Input (manual)**:
  - Use provided hostfn config and run `hostfn deploy <env> --ci`.
- **Expected output**:
  - Services start and are reachable; smoke run can be created.

### TV-DEPLOY-003 Positive: Deployment docs enumerate env vars/secrets
- **Input**: Read deployment docs.
- **Expected output**:
  - All required env vars and required secrets are listed.
  - Secrets reference secfn as storage source.
- **Negative variant(s)**: TV-DEPLOY-003N.

### TV-DEPLOY-003N Negative: Missing required env var is detected
- **Input**: Start control plane without required env var (e.g. missing registration token reference).
- **Expected output**:
  - Startup fails fast with a clear error message.

---

## Limits (LIMIT)

### TV-LIMIT-001 Negative: Pipeline document size cap enforced
- **Input**: Pipeline document > 500KB.
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-LIMIT-002 Negative: Jobs/steps/depth caps enforced
- **Input**:
  - Pipeline with 101 jobs, OR 101 steps in a job, OR needs depth 11.
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-LIMIT-003 Negative: Artifact name/cache key length caps enforced
- **Input**:
  - artifact name length 257, OR cache key length 1025.
- **Expected output**:
  - Validation fails with `PIPELINE_INVALID`.

### TV-LIMIT-004 Positive: Parse+validate benchmark reports time
- **Input**: Run benchmark harness on a near-max pipeline.
- **Expected output**:
  - Benchmark prints measured duration (ms) and succeeds.
- **Negative variant(s)**: TV-LIMIT-004N.

### TV-LIMIT-004N Negative: Benchmark harness missing fails clearly
- **Input**: Attempt to run benchmark without required fixture.
- **Expected output**:
  - Fails with clear message; does not affect normal tests.

### TV-LIMIT-005 Negative: No autoscaling behavior
- **Input**: Inspect code paths / run integration test under load.
- **Expected output**:
  - No runner provisioning is attempted.
- **Negative variant(s)**: TV-LIMIT-005N.

### TV-LIMIT-005N Negative: Unexpected provisioning attempts fail
- **Input**: Simulate missing runners.
- **Expected output**:
  - System queues jobs; does not attempt to create runner resources.

