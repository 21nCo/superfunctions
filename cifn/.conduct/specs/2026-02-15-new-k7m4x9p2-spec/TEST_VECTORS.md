# CiFn Python SDK Test Vectors

---

## Package structure

### TV-PKG-001
- **Description**: Package imports work from top-level `cifn`
- **Input**: `from cifn import CiFnClient, CiFnConfig, create_cifn, __version__`
- **Expected output**: No ImportError; `__version__` is a string matching `"0.0.1"`.

### TV-PKG-002
- **Description**: Package has minimal runtime dependencies
- **Input**: Parse `pyproject.toml` `[project.dependencies]`
- **Expected output**: Exactly `["pydantic>=2.5.0", "httpx>=0.27.0"]`.

### TV-PKG-003
- **Description**: All public types importable
- **Input**: `from cifn import Run, Job, Step, PipelineSpec, RunStatus, TriggerType, CiFnError`
- **Expected output**: No ImportError.

---

## Configuration

### TV-CFG-001
- **Description**: Default config values
- **Input**:
  ```python
  config = CiFnConfig()
  ```
- **Expected output**:
  ```python
  config.base_url == "http://localhost:3100"
  config.api_key is None
  config.token is None
  config.timeout == 30.0
  config.verify_ssl is True
  ```

### TV-CFG-002
- **Description**: Config with api_key
- **Input**:
  ```python
  config = CiFnConfig(api_key="test-key-123")
  ```
- **Expected output**:
  ```python
  config.api_key == "test-key-123"
  ```

### TV-CFG-003
- **Description**: Config with both api_key and token; api_key takes precedence
- **Input**:
  ```python
  config = CiFnConfig(api_key="key-a", token="key-b")
  ```
- **Expected output**: Client uses `"key-a"` as auth header value.

### TV-CFG-004
- **Description**: Factory function creates client
- **Input**:
  ```python
  client = create_cifn(CiFnConfig(base_url="http://my-server:3100"))
  ```
- **Expected output**: `isinstance(client, CiFnClient)` is True.

---

## Type definitions

### TV-TYPE-001
- **Description**: Enum values match TypeScript literals
- **Input**:
  ```python
  TriggerType.PUSH, RunStatus.QUEUED, JobStatus.PENDING, StepStatus.SKIPPED, StepUsesType.CHECKOUT, ErrorCode.RUN_NOT_FOUND
  ```
- **Expected output**:
  ```python
  TriggerType.PUSH.value == "push"
  RunStatus.QUEUED.value == "queued"
  JobStatus.PENDING.value == "pending"
  StepStatus.SKIPPED.value == "skipped"
  StepUsesType.CHECKOUT.value == "checkout"
  ErrorCode.RUN_NOT_FOUND.value == "RUN_NOT_FOUND"
  ```

### TV-TYPE-002
- **Description**: PipelineSpec deserialization from camelCase JSON
- **Input**:
  ```json
  {
    "name": "build-and-test",
    "on": {
      "push": { "branches": ["main"] },
      "workflow_dispatch": {}
    },
    "env": { "NODE_VERSION": "20" },
    "jobs": {
      "build": {
        "runs-on": "default",
        "steps": [
          { "uses": "checkout" },
          { "run": "npm ci" },
          { "uses": "artifact/upload", "with": { "name": "dist", "path": "dist/" } }
        ]
      },
      "test": {
        "runs-on": "default",
        "needs": ["build"],
        "steps": [
          { "uses": "checkout" },
          { "uses": "testfn/run", "with": { "config": "vitest.config.ts" } }
        ]
      }
    }
  }
  ```
- **Expected output**:
  ```python
  spec = PipelineSpec.model_validate(input)
  spec.name == "build-and-test"
  spec.on.push.branches == ["main"]
  spec.on.workflow_dispatch == {}
  len(spec.jobs) == 2
  spec.jobs["build"].runs_on == "default"
  len(spec.jobs["build"].steps) == 3
  isinstance(spec.jobs["build"].steps[0], UsesStep)
  isinstance(spec.jobs["build"].steps[1], RunStep)
  spec.jobs["test"].needs == ["build"]
  ```

### TV-TYPE-003
- **Description**: PipelineSpec serialization to camelCase JSON
- **Input**:
  ```python
  spec = PipelineSpec(
      name="test",
      on=OnTriggers(push=OnPush(branches=["main"])),
      jobs={"build": JobSpec(runs_on="default", steps=[RunStep(run="npm ci")])}
  )
  spec.model_dump(mode="json", by_alias=True)
  ```
- **Expected output**:
  ```json
  {
    "name": "test",
    "on": { "push": { "branches": ["main"] } },
    "jobs": { "build": { "runs-on": "default", "steps": [{ "run": "npm ci" }] } }
  }
  ```
- **Notes**: `None` optional fields excluded.

### TV-TYPE-004
- **Description**: Run deserialization from server response
- **Input**:
  ```json
  {
    "id": "run-abc-123",
    "pipelineRef": { "repo": "my/repo", "ref": "main" },
    "trigger": { "type": "push", "payload": { "branch": "main" } },
    "status": "running",
    "createdAt": "2026-02-15T10:00:00Z",
    "updatedAt": "2026-02-15T10:01:00Z",
    "jobs": [
      {
        "id": "job-1",
        "runId": "run-abc-123",
        "jobKey": "build",
        "status": "success",
        "steps": [
          {
            "id": "step-1",
            "jobId": "job-1",
            "stepKey": "step-0",
            "status": "success",
            "startedAt": "2026-02-15T10:00:01Z",
            "completedAt": "2026-02-15T10:00:30Z"
          }
        ],
        "startedAt": "2026-02-15T10:00:01Z",
        "completedAt": "2026-02-15T10:00:30Z"
      }
    ]
  }
  ```
- **Expected output**:
  ```python
  run = Run.model_validate(input)
  run.id == "run-abc-123"
  run.status == RunStatus.RUNNING
  run.trigger.type == TriggerType.PUSH
  len(run.jobs) == 1
  run.jobs[0].job_key == "build"
  run.jobs[0].status == JobStatus.SUCCESS
  len(run.jobs[0].steps) == 1
  run.jobs[0].steps[0].step_key == "step-0"
  ```

### TV-TYPE-005
- **Description**: Run deserialization with missing optional fields
- **Input**:
  ```json
  {
    "id": "run-xyz",
    "trigger": { "type": "workflow_dispatch" },
    "status": "queued",
    "createdAt": "2026-02-15T10:00:00Z",
    "updatedAt": "2026-02-15T10:00:00Z"
  }
  ```
- **Expected output**:
  ```python
  run = Run.model_validate(input)
  run.pipeline_ref is None
  run.jobs == []
  run.status == RunStatus.QUEUED
  ```

### TV-TYPE-006
- **Description**: CreateRunResult deserialization
- **Input**:
  ```json
  { "runId": "run-new-1", "status": "queued", "createdAt": "2026-02-15T12:00:00Z" }
  ```
- **Expected output**:
  ```python
  result = CreateRunResult.model_validate(input)
  result.run_id == "run-new-1"
  result.status == RunStatus.QUEUED
  result.created_at == "2026-02-15T12:00:00Z"
  ```

### TV-TYPE-007
- **Description**: ListRunsResult with pagination
- **Input**:
  ```json
  {
    "runs": [
      { "id": "r1", "trigger": {"type": "push"}, "status": "success", "createdAt": "2026-02-15T10:00:00Z", "updatedAt": "2026-02-15T10:01:00Z" }
    ],
    "nextCursor": "cursor-abc"
  }
  ```
- **Expected output**:
  ```python
  result = ListRunsResult.model_validate(input)
  len(result.runs) == 1
  result.next_cursor == "cursor-abc"
  ```

### TV-TYPE-008
- **Description**: Models accept both snake_case and camelCase
- **Input**:
  ```python
  # camelCase
  a = CreateRunResult(runId="r1", status="queued", createdAt="2026-01-01T00:00:00Z")
  # snake_case
  b = CreateRunResult(run_id="r1", status="queued", created_at="2026-01-01T00:00:00Z")
  ```
- **Expected output**: Both succeed; `a.run_id == b.run_id == "r1"`.

### TV-TYPE-009
- **Description**: Step discriminated union
- **Input**:
  ```python
  from pydantic import TypeAdapter
  adapter = TypeAdapter(List[Union[RunStep, UsesStep]])
  steps = adapter.validate_python([
      {"run": "npm ci"},
      {"uses": "checkout"},
      {"uses": "artifact/upload", "with": {"name": "dist", "path": "dist/"}},
  ])
  ```
- **Expected output**:
  ```python
  isinstance(steps[0], RunStep)
  steps[0].run == "npm ci"
  isinstance(steps[1], UsesStep)
  steps[1].uses == StepUsesType.CHECKOUT
  isinstance(steps[2], UsesStep)
  steps[2].with_params == {"name": "dist", "path": "dist/"}
  ```

---

## Client methods

### TV-CLIENT-001
- **Description**: Client sends auth header
- **Input**: Create client with `api_key="my-key"`, send any request.
- **Expected output**: Request includes header `Authorization: Bearer my-key`.

### TV-CLIENT-002
- **Description**: create_run success with pipeline_spec
- **Input**:
  ```python
  result = await client.create_run(
      trigger=TriggerInput(type=TriggerType.PUSH),
      pipeline_spec=PipelineSpec(
          on=OnTriggers(push=OnPush(branches=["main"])),
          jobs={"build": JobSpec(runs_on="default", steps=[RunStep(run="echo hello")])}
      )
  )
  ```
- **Mock server response** (201):
  ```json
  { "ok": true, "data": { "runId": "run-1", "status": "queued", "createdAt": "2026-02-15T12:00:00Z" } }
  ```
- **Expected output**:
  ```python
  isinstance(result, CreateRunResult)
  result.run_id == "run-1"
  result.status == RunStatus.QUEUED
  ```

### TV-CLIENT-003
- **Description**: create_run with invalid pipeline
- **Mock server response** (422):
  ```json
  { "ok": false, "error": { "code": "PIPELINE_INVALID", "message": "Pipeline validation failed: missing jobs" } }
  ```
- **Expected output**: Raises `CiFnPipelineInvalidError` with `code == ErrorCode.PIPELINE_INVALID`.

### TV-CLIENT-004
- **Description**: create_run with bad request
- **Mock server response** (400):
  ```json
  { "ok": false, "error": { "code": "BAD_REQUEST", "message": "Missing trigger field" } }
  ```
- **Expected output**: Raises `CiFnBadRequestError`.

### TV-CLIENT-005
- **Description**: list_runs with defaults
- **Input**: `await client.list_runs()`
- **Expected output**: GET request to `/api/v1/runs?limit=20`. Returns `ListRunsResult`.

### TV-CLIENT-006
- **Description**: list_runs with limit clamping
- **Input**: `await client.list_runs(limit=500)`
- **Expected output**: GET request sent with `limit=100` (clamped).

### TV-CLIENT-007
- **Description**: get_run success
- **Input**: `await client.get_run("run-abc")`
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "id": "run-abc", "trigger": {"type": "push"}, "status": "success", "createdAt": "...", "updatedAt": "...", "jobs": [] } }
  ```
- **Expected output**: `Run` instance with `id == "run-abc"`.

### TV-CLIENT-008
- **Description**: get_run not found
- **Mock server response** (404):
  ```json
  { "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Run not found" } }
  ```
- **Expected output**: Raises `CiFnRunNotFoundError`.

### TV-CLIENT-009
- **Description**: cancel_run success
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "runId": "run-abc", "status": "cancelled" } }
  ```
- **Expected output**: `CancelRunResult` with `status == RunStatus.CANCELLED`.

### TV-CLIENT-010
- **Description**: cancel_run already finished
- **Mock server response** (409):
  ```json
  { "ok": false, "error": { "code": "RUN_ALREADY_FINISHED", "message": "Run already completed" } }
  ```
- **Expected output**: Raises `CiFnRunAlreadyFinishedError`.

### TV-CLIENT-011
- **Description**: cancel_run not found
- **Mock server response** (404):
  ```json
  { "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Run not found" } }
  ```
- **Expected output**: Raises `CiFnRunNotFoundError`.

### TV-CLIENT-012
- **Description**: get_job_logs success
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "lines": [{ "line": "Building...", "timestamp": "2026-02-15T10:00:01Z", "stepKey": "step-0" }] } }
  ```
- **Expected output**: `JobLogs` with 1 line; `lines[0].line == "Building..."`.

### TV-CLIENT-013
- **Description**: get_job_logs not found
- **Mock server response** (404):
  ```json
  { "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Run or job not found" } }
  ```
- **Expected output**: Raises `CiFnRunNotFoundError`.

### TV-CLIENT-014
- **Description**: get_artifacts success
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "artifacts": [{ "name": "dist", "fileId": "file-1" }] } }
  ```
- **Expected output**: `ArtifactList` with 1 artifact; `artifacts[0].name == "dist"`.

### TV-CLIENT-015
- **Description**: get_artifacts not found
- **Mock server response** (404):
  ```json
  { "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Run not found" } }
  ```
- **Expected output**: Raises `CiFnRunNotFoundError`.

### TV-CLIENT-016
- **Description**: register_runner success
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "runnerId": "runner-1", "runnerSecret": "secret-abc" } }
  ```
- **Expected output**: `RegisterRunnerResult` with `runner_id == "runner-1"`.

### TV-CLIENT-017
- **Description**: register_runner invalid token
- **Mock server response** (401):
  ```json
  { "ok": false, "error": { "code": "RUNNER_TOKEN_INVALID", "message": "Invalid registration token" } }
  ```
- **Expected output**: Raises `CiFnRunnerTokenInvalidError`.

### TV-CLIENT-018
- **Description**: runner_heartbeat with job
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "job": { "runId": "r1", "jobKey": "build", "jobSpec": {} } } }
  ```
- **Expected output**: `HeartbeatResult` with `job` not None.

### TV-CLIENT-019
- **Description**: runner_heartbeat no job
- **Mock server response** (200):
  ```json
  { "ok": true, "data": { "job": null } }
  ```
- **Expected output**: `HeartbeatResult` with `job is None`.

### TV-CLIENT-020
- **Description**: health check success
- **Mock server response** (200): `{ "ok": true }`
- **Expected output**: `True`.

### TV-CLIENT-021
- **Description**: health check failure (server unreachable)
- **Input**: Server not running.
- **Expected output**: `False` (no exception raised).

---

## Envelope handling

### TV-ENV-001
- **Description**: Successful envelope unwrapping
- **Input**: Response `{ "ok": true, "data": { "runId": "r1" } }`
- **Expected output**: Returns `{"runId": "r1"}` dict (before Pydantic parsing).

### TV-ENV-002
- **Description**: Error envelope raises exception
- **Input**: Response `{ "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "Not found" } }`
- **Expected output**: Raises `CiFnRunNotFoundError` with message `"Not found"`.

### TV-ENV-003
- **Description**: All error codes map to correct exceptions
- **Input**: For each `ErrorCode` value, a response `{ "ok": false, "error": { "code": <code>, "message": "test" } }`
- **Expected output**: Each raises its mapped exception subclass.

### TV-ENV-004
- **Description**: Connection error raises CiFnConnectionError
- **Input**: Server unreachable (connection refused).
- **Expected output**: Raises `CiFnConnectionError`.

### TV-ENV-005
- **Description**: Non-JSON response raises CiFnError
- **Input**: Server returns `Content-Type: text/html` with HTML body.
- **Expected output**: Raises `CiFnError` with code-like `INTERNAL_ERROR`.

### TV-ENV-006
- **Description**: Unknown error code raises base CiFnError
- **Input**: Response `{ "ok": false, "error": { "code": "SOMETHING_NEW", "message": "unknown" } }`
- **Expected output**: Raises `CiFnError` (base class, not a subclass).

### TV-ENV-007
- **Description**: Exception includes HTTP status code
- **Input**: 404 response with `RUN_NOT_FOUND`.
- **Expected output**: `exception.http_status == 404`.

---

## Security

### TV-SEC-001
- **Description**: Config repr redacts credentials
- **Input**: `repr(CiFnConfig(api_key="super-secret-key"))`
- **Expected output**: String does NOT contain `"super-secret-key"`; contains `"***"` or `"<redacted>"`.

### TV-SEC-002
- **Description**: Exception messages do not contain tokens
- **Input**: Create client with `api_key="secret"`, trigger an `UNAUTHORIZED` error.
- **Expected output**: `str(exception)` does NOT contain `"secret"`.

### TV-SEC-003
- **Description**: Default SSL verification enabled
- **Input**: `CiFnConfig()`.
- **Expected output**: `config.verify_ssl is True`.

---

## Sync wrappers

### TV-SYNC-001
- **Description**: Sync wrapper produces same result as async
- **Input**:
  ```python
  async_result = await client.list_runs()
  sync_result = client.list_runs_sync()
  ```
- **Expected output**: Both return equivalent `ListRunsResult`.

### TV-SYNC-002
- **Description**: Sync wrapper works when event loop is already running
- **Input**: Call `client.create_run_sync(...)` from within an async context (e.g. `asyncio.run()` calling sync code).
- **Expected output**: No `RuntimeError`; returns `CreateRunResult`.
