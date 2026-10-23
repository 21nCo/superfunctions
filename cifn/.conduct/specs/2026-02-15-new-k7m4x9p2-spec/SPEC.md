# CiFn Python SDK Specification

## Metadata

- **timestamp**: 2026-02-15T19:45:00Z (UTC)
- **agent_name**: unknown-agent
- **model**: Claude Sonnet 4.5 (claude-sonnet-4-5-20250929)
- **launcher**: Cursor (VSCode Extension)
- **workspace/project absolute path**: /Users/serro/Documents/dev/n/superfunctions/cifn
- **OS + shell**: darwin 25.2.0, zsh
- **repo metadata**:
  - **git repo**: yes (superfunctions monorepo)
  - **repo root**: /Users/serro/Documents/dev/n/superfunctions
  - **branch**: next
  - **dirty status**: dirty
- **spec_folder**: 2026-02-15-new-k7m4x9p2-spec
- **spec_folder full path**: cifn/.conduct/specs/2026-02-15-new-k7m4x9p2-spec
- **spec_type**: new
- **spec_id**: k7m4x9p2
- **input paths**:
  - cifn/SPEC.md (authoritative intent)
  - cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec/SPEC.md (TypeScript implementation spec)
  - cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec/REQUIREMENTS.md (TypeScript requirements)
  - cifn/typescript/control-plane/src/index.ts (TypeScript exports)
  - cifn/typescript/control-plane/src/api/routes.ts (HTTP API endpoints)
  - cachefn/python/pyproject.toml (ecosystem pattern reference)
  - authfn/python/ (ecosystem pattern reference)
  - sendfn/python/ (ecosystem pattern reference)

---

## Overview

The CiFn Python SDK (`cifn`) is a **thin HTTP client library** that wraps the CiFn control plane REST API (`/api/v1/*`) for Python developers. It provides:

- A typed, async-first HTTP client for all control plane endpoints (runs, runners, webhooks, artifacts, logs)
- Pydantic v2 models mirroring the TypeScript types (PipelineSpec, Run, Job, Step, etc.)
- A Python exception hierarchy mapping CiFn error codes to typed exceptions
- An envelope-aware response parser that unwraps `{ ok, data }` / `{ ok, error }` responses automatically

This is NOT a reimplementation of the control plane, runner, CLI, or dashboard. It is a pure API client that talks to an existing CiFn control plane server over HTTP.

**One-sentence goal**: Provide Python developers a typed, async HTTP client for the CiFn control plane API, following superfunctions ecosystem conventions.

**Target users**: Python developers who need to programmatically trigger CI runs, query run status, fetch logs/artifacts, or register runners against a running CiFn control plane.

**Target environments**: Python 3.10+, any OS. Requires network access to a CiFn control plane server. No offline mode.

**Languages/packages**: Python 3.10+. Dependencies: `pydantic>=2.5.0`, `httpx>=0.27.0`. No dependency on `superfunctions` core (`sfns`) — per AGENTS.md, shared packages SHOULD be reused, but `superfunctions.db` (database adapters) and `superfunctions.http` (server-side route/handler abstractions) are not applicable because this SDK is a pure HTTP *client* with no local storage and no server-side route exposure. There is no shared client-side HTTP utility in the ecosystem.

**Existing systems**: Talks to the CiFn control plane HTTP API (TypeScript server). No direct integration with flowfn/filefn/secfn/logfn (those are server-side concerns).

**Data model**: Mirrors the TypeScript types as Pydantic models. No local persistence. All state lives on the control plane server.

**Security model**: Bearer token or API key authentication passed as header to the control plane. Tokens are user-provided configuration; the SDK MUST NOT store or log them beyond initial configuration.

**Performance constraints**: HTTP client; latency bounded by network + server response time. No local caching of responses. Connection pooling via httpx.

**Non-goals**:
- Reimplementing pipeline parsing/validation (server-side)
- Reimplementing the runner (server-side)
- Reimplementing the CLI (use the TypeScript CLI)
- Reimplementing the dashboard (use the TypeScript dashboard)
- Providing framework-agnostic HTTP routes (no server-side Python component)

**Hard constraints**:
- MUST use Pydantic v2 for all data models
- MUST use httpx for HTTP transport (async-native)
- MUST follow superfunctions Python ecosystem conventions (hatchling build, ruff, black, mypy, pytest-asyncio)
- MUST NOT store or log authentication tokens
- MUST handle the CiFn canonical envelope (`{ ok, data }` / `{ ok, error }`) transparently

---

## Glossary

- **CiFn control plane**: The TypeScript HTTP server that manages pipeline runs, job dispatch, and runner registration. Listens on `/api/v1/*`.
- **SDK client**: The Python `CiFnClient` class that wraps HTTP calls to the control plane.
- **Envelope**: The canonical response shape: `{ "ok": true, "data": T }` or `{ "ok": false, "error": { "code": str, "message": str, "details"?: dict } }`.
- **PipelineSpec**: A parsed pipeline configuration (name, triggers, env, jobs with steps). Defined as a Pydantic model.
- **Run**: One execution of a pipeline. Has `run_id`, `status`, `trigger`, `jobs`.
- **Job**: One named job within a run. Has `job_key`, `status`, `steps`.
- **Step**: One unit of work within a job. Either `run` (shell) or `uses` (checkout, cache, artifact, testfn, hostfn).
- **RunStatus**: `queued | running | success | failure | cancelled`.
- **JobStatus / StepStatus**: `pending | running | success | failure | skipped`.
- **TriggerType**: `push | pull_request | schedule | workflow_dispatch`.
- **StepUsesType**: `checkout | cache/restore | cache/save | artifact/upload | artifact/download | testfn/run | hostfn/deploy`.
- **ErrorCode**: One of `BAD_REQUEST`, `UNAUTHORIZED`, `RUNNER_TOKEN_INVALID`, `PIPELINE_INVALID`, `RUN_CREATE_FAILED`, `RUN_NOT_FOUND`, `RUN_ALREADY_FINISHED`, `RUNNER_NOT_FOUND`, `INTERNAL_ERROR`.

---

## Goals

1. Typed HTTP client for all CiFn control plane `/api/v1` endpoints.
2. Pydantic v2 models for all request/response types (PipelineSpec, Run, Job, Step, triggers, envelopes).
3. Async-first using httpx; optional sync wrappers.
4. Exception hierarchy mapping CiFn error codes to Python exceptions.
5. Transparent envelope unwrapping (caller receives `data` directly, errors raise exceptions).
6. Follow superfunctions Python ecosystem conventions (project structure, tooling, naming).
7. Minimal dependencies (pydantic, httpx only).

## Non-goals

- Server-side pipeline parsing or validation.
- Runner implementation.
- CLI implementation.
- Dashboard or UI.
- Framework-agnostic route generation (no server-side component).
- Integration adapter interfaces (those are server-side concerns).

---

## Public API

### Factory function

```python
def create_cifn(config: CiFnConfig) -> CiFnClient:
    """Create a CiFn client instance."""
```

### Configuration

```python
class CiFnConfig(BaseModel):
    base_url: str = "http://localhost:3100"
    api_key: Optional[str] = None
    token: Optional[str] = None  # alias for api_key
    timeout: float = 30.0

    class Config:
        populate_by_name = True
```

Either `api_key` or `token` MAY be provided. If both, `api_key` takes precedence. The value is sent as `Authorization: Bearer <value>` header on all requests except `/health`.

### CiFnClient methods

#### Run management

```python
async def create_run(
    self,
    trigger: TriggerInput,
    pipeline_spec: Optional[PipelineSpec] = None,
    pipeline_ref: Optional[PipelineRef] = None,
) -> CreateRunResult:
    """POST /api/v1/runs"""

async def list_runs(
    self,
    limit: int = 20,
    cursor: Optional[str] = None,
    status: Optional[RunStatus] = None,
) -> ListRunsResult:
    """GET /api/v1/runs"""

async def get_run(self, run_id: str) -> Run:
    """GET /api/v1/runs/:runId"""

async def cancel_run(self, run_id: str) -> CancelRunResult:
    """POST /api/v1/runs/:runId/cancel"""

async def get_job_logs(self, run_id: str, job_key: str) -> JobLogs:
    """GET /api/v1/runs/:runId/jobs/:jobKey/logs"""

async def get_artifacts(self, run_id: str) -> ArtifactList:
    """GET /api/v1/runs/:runId/artifacts"""
```

#### Runner management

```python
async def register_runner(
    self,
    token: str,
    labels: Optional[List[str]] = None,
) -> RegisterRunnerResult:
    """POST /api/v1/runners/register"""

async def runner_heartbeat(
    self,
    runner_id: str,
    runner_secret: str,
) -> HeartbeatResult:
    """POST /api/v1/runners/heartbeat"""
```

#### Webhooks

```python
async def trigger_github_webhook(
    self,
    event: str,
    payload: dict,
    signature: str,
) -> None:
    """POST /webhooks/github"""
```

#### Health

```python
async def health(self) -> bool:
    """GET /health"""
```

#### Sync wrappers

```python
def create_run_sync(self, ...) -> CreateRunResult:
def list_runs_sync(self, ...) -> ListRunsResult:
def get_run_sync(self, run_id: str) -> Run:
def cancel_run_sync(self, run_id: str) -> CancelRunResult:
def get_job_logs_sync(self, run_id: str, job_key: str) -> JobLogs:
def get_artifacts_sync(self, run_id: str) -> ArtifactList:
def register_runner_sync(self, ...) -> RegisterRunnerResult:
def runner_heartbeat_sync(self, ...) -> HeartbeatResult:
def health_sync(self) -> bool:
```

Each sync wrapper calls the corresponding async method using `asyncio.run()` or a private event loop.

#### Context manager

```python
async def __aenter__(self) -> "CiFnClient": ...
async def __aexit__(self, *args) -> None: ...
def close(self) -> None: ...
```

Client MUST support `async with` for connection lifecycle management. `close()` MUST close the underlying httpx client.

---

## Data formats / protocol

### Request format

All requests use `Content-Type: application/json`. Authentication via `Authorization: Bearer <token>` header.

### Response envelope (from server)

```json
{ "ok": true, "data": <T> }
```
or
```json
{ "ok": false, "error": { "code": "<ErrorCode>", "message": "<string>", "details": {} } }
```

The SDK MUST unwrap envelopes automatically:
- On `ok: true`: return parsed `data` as the appropriate Pydantic model.
- On `ok: false`: raise the corresponding `CiFnError` subclass with code, message, and details.

### Type definitions (Pydantic models)

#### Pipeline configuration

```python
class PipelineRef(BaseModel):
    repo: str
    ref: str
    config_path: Optional[str] = Field(None, alias="configPath")

class TriggerInput(BaseModel):
    type: TriggerType
    payload: Optional[Dict[str, Any]] = None

class OnPush(BaseModel):
    branches: List[str]

class OnPullRequest(BaseModel):
    branches: List[str]

class OnSchedule(BaseModel):
    cron: str

class OnTriggers(BaseModel):
    push: Optional[OnPush] = None
    pull_request: Optional[OnPullRequest] = None
    schedule: Optional[List[OnSchedule]] = None
    workflow_dispatch: Optional[Dict[str, Any]] = None

class RunStep(BaseModel):
    run: str
    if_condition: Optional[str] = Field(None, alias="if")

class UsesStep(BaseModel):
    uses: StepUsesType
    with_params: Optional[Dict[str, Any]] = Field(None, alias="with")
    if_condition: Optional[str] = Field(None, alias="if")

class JobSpec(BaseModel):
    runs_on: str = Field(alias="runs-on")
    image: Optional[str] = None
    needs: Optional[List[str]] = None
    if_condition: Optional[str] = Field(None, alias="if")
    env: Optional[Dict[str, str]] = None
    steps: List[Union[RunStep, UsesStep]]

class PipelineSpec(BaseModel):
    name: Optional[str] = None
    on: OnTriggers
    env: Optional[Dict[str, str]] = None
    jobs: Dict[str, JobSpec]
```

#### Runtime objects

```python
class Step(BaseModel):
    id: str
    job_id: str = Field(alias="jobId")
    step_key: str = Field(alias="stepKey")
    status: StepStatus
    started_at: Optional[str] = Field(None, alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")

class Job(BaseModel):
    id: str
    run_id: str = Field(alias="runId")
    job_key: str = Field(alias="jobKey")
    status: JobStatus
    steps: List[Step]
    started_at: Optional[str] = Field(None, alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")

class Run(BaseModel):
    id: str
    pipeline_ref: Optional[PipelineRef] = Field(None, alias="pipelineRef")
    trigger: TriggerInput
    status: RunStatus
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    jobs: List[Job] = []
```

#### Response models

```python
class CreateRunResult(BaseModel):
    run_id: str = Field(alias="runId")
    status: RunStatus
    created_at: str = Field(alias="createdAt")

class ListRunsResult(BaseModel):
    runs: List[Run]
    next_cursor: Optional[str] = Field(None, alias="nextCursor")

class CancelRunResult(BaseModel):
    run_id: str = Field(alias="runId")
    status: RunStatus

class Artifact(BaseModel):
    name: str
    file_id: Optional[str] = Field(None, alias="fileId")
    url: Optional[str] = None

class ArtifactList(BaseModel):
    artifacts: List[Artifact]

class JobLogLine(BaseModel):
    line: str
    timestamp: str
    step_key: str = Field(alias="stepKey")

class JobLogs(BaseModel):
    lines: List[JobLogLine]

class RegisterRunnerResult(BaseModel):
    runner_id: str = Field(alias="runnerId")
    runner_secret: str = Field(alias="runnerSecret")

class HeartbeatResult(BaseModel):
    job: Optional[Dict[str, Any]] = None
```

#### Enums

```python
class TriggerType(str, Enum):
    PUSH = "push"
    PULL_REQUEST = "pull_request"
    SCHEDULE = "schedule"
    WORKFLOW_DISPATCH = "workflow_dispatch"

class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"

class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    SKIPPED = "skipped"

class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    SKIPPED = "skipped"

class StepUsesType(str, Enum):
    CHECKOUT = "checkout"
    CACHE_RESTORE = "cache/restore"
    CACHE_SAVE = "cache/save"
    ARTIFACT_UPLOAD = "artifact/upload"
    ARTIFACT_DOWNLOAD = "artifact/download"
    TESTFN_RUN = "testfn/run"
    HOSTFN_DEPLOY = "hostfn/deploy"

class ErrorCode(str, Enum):
    BAD_REQUEST = "BAD_REQUEST"
    UNAUTHORIZED = "UNAUTHORIZED"
    RUNNER_TOKEN_INVALID = "RUNNER_TOKEN_INVALID"
    PIPELINE_INVALID = "PIPELINE_INVALID"
    RUN_CREATE_FAILED = "RUN_CREATE_FAILED"
    RUN_NOT_FOUND = "RUN_NOT_FOUND"
    RUN_ALREADY_FINISHED = "RUN_ALREADY_FINISHED"
    RUNNER_NOT_FOUND = "RUNNER_NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"
```

---

## Semantics

### Envelope unwrapping

Every HTTP response from the control plane is wrapped in the canonical envelope. The SDK MUST:
1. Parse the response body as JSON.
2. Check the `ok` field.
3. If `ok` is `true`: parse `data` into the appropriate Pydantic model and return it.
4. If `ok` is `false`: parse `error` and raise the corresponding `CiFnError` subclass.
5. If the response is not valid JSON or does not contain `ok`: raise `CiFnError` with code `INTERNAL_ERROR`.

### HTTP status code handling

- 2xx with `ok: true`: success path.
- 4xx/5xx with `ok: false`: error path (mapped to exceptions).
- Network errors (connection refused, timeout): raise `CiFnConnectionError`.
- Non-JSON responses: raise `CiFnError` with `INTERNAL_ERROR`.

### Authentication

- If `api_key` (or `token`) is set in config, the SDK MUST send `Authorization: Bearer <value>` on every request except `GET /health`.
- If no key is configured, requests are sent without auth (server decides whether to accept).
- The SDK MUST NOT log, print, or persist the token value.

### Serialization

- Request bodies MUST be serialized using Pydantic's `model_dump(mode="json", by_alias=True)` to produce camelCase keys matching the TypeScript API.
- Response bodies MUST be deserialized using `model_validate()` with camelCase aliases.
- All `Optional` fields with `None` values SHOULD be excluded from request bodies.

### Connection lifecycle

- `CiFnClient` creates an `httpx.AsyncClient` internally.
- The client MUST be usable as an async context manager (`async with`).
- `close()` MUST close the underlying httpx client and release connections.
- Calling methods after `close()` MUST raise `CiFnError`.

---

## Invariants

1. Every successful SDK method call returns a Pydantic model instance (never raw dict or JSON).
2. Every error response from the server raises a `CiFnError` subclass (never returns `None` or raw error dict).
3. The SDK MUST NOT mutate input models passed to methods.
4. The SDK MUST NOT store or cache responses (stateless client).
5. All Pydantic models MUST accept both snake_case and camelCase field names (`populate_by_name = True`).
6. Sync wrappers MUST produce identical results to their async counterparts.

---

## Security

- Token/API key MUST NOT appear in exception messages, log output, or `repr()` of the client.
- `CiFnConfig.__repr__` MUST redact `api_key` and `token` fields.
- The SDK MUST NOT disable TLS verification by default. An optional `verify_ssl: bool = True` config field MAY be provided for development.

---

## Limits/caps

- No client-side rate limiting (server-side concern).
- `timeout` config field controls per-request timeout (default 30s).
- No max response size enforcement (httpx handles this).
- `limit` parameter for `list_runs` MUST be clamped to 1-100 on the client side before sending.

---

## Observability

- The SDK MUST NOT log by default. No logging calls unless user configures a logger.
- The SDK MAY accept an optional `logger` parameter in config for debug logging.
- Debug logging (if enabled) MUST NOT include token values or full response bodies.

---

## Compatibility / versioning

- Package version starts at `0.0.1`.
- The SDK targets CiFn control plane API v1 (`/api/v1`).
- New optional fields on response models MUST NOT be breaking (Pydantic ignores unknown fields by default).
- SDK version follows semver; breaking changes to the client API require a major version bump.

---

## Undefined / Explicitly user-deferred only

- **Webhook signature generation**: The SDK provides `trigger_github_webhook` for forwarding, but generating HMAC signatures is the caller's responsibility. The SDK MAY add a helper in a later version.
- **Pipeline YAML parsing**: Server-side; the SDK sends PipelineSpec as JSON.
- **Local pipeline execution**: Not in scope; the TypeScript CLI handles this.
- **Retry logic**: Not built in; the caller may use tenacity or similar.
- **WebSocket/SSE streaming**: Not in scope for v1; log retrieval is polling-based.
