# CiFn Python SDK Requirements

## Table of contents

- [PKG-001](#pkg-001) ... [PKG-004](#pkg-004) Package structure and conventions
- [CFG-001](#cfg-001) ... [CFG-003](#cfg-003) Configuration
- [TYPE-001](#type-001) ... [TYPE-007](#type-007) Type definitions (Pydantic models)
- [CLIENT-001](#client-001) ... [CLIENT-010](#client-010) HTTP client methods
- [ENV-001](#env-001) ... [ENV-003](#env-003) Envelope handling and error mapping
- [SYNC-001](#sync-001) ... [SYNC-002](#sync-002) Sync wrappers
- [SEC-001](#sec-001) ... [SEC-003](#sec-003) Security
- [TEST-001](#test-001) ... [TEST-003](#test-003) Testing

---

## Package structure and conventions

### PKG-001
- **Priority**: P0
- **Statement**: The package MUST be structured as `cifn/python/cifn/` with hatchling build system, following the superfunctions ecosystem layout (`pyproject.toml`, `cifn/` source package, `tests/` directory).
- **Rationale**: Consistency with authfn, cachefn, sendfn, and other superfunctions Python packages.
- **Acceptance criteria**:
  - `cifn/python/pyproject.toml` exists with hatchling build config.
  - `cifn/python/cifn/__init__.py` exports version, main classes, and factory function.
  - `cifn/python/tests/` contains test files.
- **Test vectors**: TV-PKG-001
- **Notes**: Package name on PyPI is `cifn`.

### PKG-002
- **Priority**: P0
- **Statement**: The package MUST declare dependencies on `pydantic>=2.5.0` and `httpx>=0.27.0` only. Dev dependencies MUST include `pytest`, `pytest-asyncio`, `pytest-cov`, `mypy`, `ruff`, `black`.
- **Rationale**: Minimal dependency footprint; async-native HTTP with httpx.
- **Acceptance criteria**:
  - `pyproject.toml` `[project.dependencies]` lists exactly pydantic and httpx.
  - `[project.optional-dependencies].dev` lists all dev tools.
  - No other runtime dependencies.
- **Test vectors**: TV-PKG-002
- **Notes**: No dependency on `superfunctions` core package (`sfns`). Per AGENTS.md, shared packages SHOULD be reused — however `superfunctions.db` (database adapters) and `superfunctions.http` (server-side route/handler abstractions) are not applicable here because this SDK is a pure HTTP *client* with no storage and no server-side route exposure. There is no shared client-side HTTP utility in the ecosystem.

### PKG-003
- **Priority**: P0
- **Statement**: The `__init__.py` MUST export: `CiFnClient`, `CiFnConfig`, `create_cifn`, all Pydantic model classes, all enum classes, all exception classes, and `__version__`.
- **Rationale**: Clean public API surface; users import from `cifn` directly.
- **Acceptance criteria**:
  - `from cifn import CiFnClient, CiFnConfig, create_cifn` works.
  - `from cifn import Run, Job, Step, PipelineSpec` works.
  - `from cifn import CiFnError, RunNotFoundError` works.
  - `__all__` lists all public exports.
- **Test vectors**: TV-PKG-003
- **Notes**: Follow `__all__` pattern from authfn/sendfn.

### PKG-004
- **Priority**: P1
- **Statement**: The package MUST pass `ruff` linting (rules E, W, F, I, B, C4), `black` formatting (line-length 100), and `mypy --strict` type checking with zero errors.
- **Rationale**: Code quality consistency with ecosystem.
- **Acceptance criteria**:
  - `ruff check cifn/` passes with zero errors.
  - `black --check cifn/` passes.
  - `mypy cifn/` passes with zero errors under strict mode.
- **Test vectors**: N/A (tooling check)
- **Notes**: Target Python 3.10.

---

## Configuration

### CFG-001
- **Priority**: P0
- **Statement**: `CiFnConfig` MUST be a Pydantic `BaseModel` with fields: `base_url` (str, default `"http://localhost:3100"`), `api_key` (Optional[str], default None), `token` (Optional[str], default None, alias for api_key), `timeout` (float, default 30.0), `verify_ssl` (bool, default True).
- **Rationale**: Standard configuration pattern; matches ecosystem conventions.
- **Acceptance criteria**:
  - Config with no arguments uses defaults.
  - Config with `api_key="abc"` sets auth token.
  - Config with `token="abc"` sets auth token (alias).
  - If both `api_key` and `token` provided, `api_key` takes precedence.
- **Test vectors**: TV-CFG-001, TV-CFG-002, TV-CFG-003
- **Notes**: `populate_by_name = True` for camelCase/snake_case flexibility.

### CFG-002
- **Priority**: P0
- **Statement**: `create_cifn(config: CiFnConfig) -> CiFnClient` MUST be a factory function that creates and returns a `CiFnClient` instance.
- **Rationale**: Factory pattern consistent with `create_cache`, `create_auth`, etc.
- **Acceptance criteria**:
  - `create_cifn(CiFnConfig())` returns a `CiFnClient`.
  - `create_cifn(CiFnConfig(base_url="http://custom:9000"))` sets custom base URL.
- **Test vectors**: TV-CFG-004
- **Notes**: None.

### CFG-003
- **Priority**: P1
- **Statement**: `CiFnConfig.__repr__` MUST redact `api_key` and `token` fields, displaying `"***"` instead of the actual value.
- **Rationale**: Prevent accidental credential exposure in logs or error messages.
- **Acceptance criteria**:
  - `repr(CiFnConfig(api_key="secret123"))` does NOT contain `"secret123"`.
  - `repr(CiFnConfig(api_key="secret123"))` contains `"***"` for the api_key field.
- **Test vectors**: TV-SEC-001
- **Notes**: Override `__repr__` or use Pydantic's `exclude` / custom serializer.

---

## Type definitions (Pydantic models)

### TYPE-001
- **Priority**: P0
- **Statement**: The SDK MUST define enum types `TriggerType`, `RunStatus`, `JobStatus`, `StepStatus`, `StepUsesType`, and `ErrorCode` as `str, Enum` subclasses with values matching the TypeScript string literals exactly.
- **Rationale**: Type-safe representation of server enums; string-compatible for JSON serialization.
- **Acceptance criteria**:
  - `TriggerType.PUSH.value == "push"`.
  - `RunStatus("queued") == RunStatus.QUEUED`.
  - All enum values match the TypeScript definitions.
- **Test vectors**: TV-TYPE-001
- **Notes**: Use `str, Enum` pattern for JSON compatibility.

### TYPE-002
- **Priority**: P0
- **Statement**: The SDK MUST define Pydantic models for pipeline configuration: `PipelineRef`, `TriggerInput`, `OnPush`, `OnPullRequest`, `OnSchedule`, `OnTriggers`, `RunStep`, `UsesStep`, `JobSpec`, `PipelineSpec`. All MUST use `Field(alias=...)` for camelCase JSON keys where the Python field name differs (e.g. `runs_on` -> `"runs-on"`, `if_condition` -> `"if"`, `with_params` -> `"with"`, `config_path` -> `"configPath"`).
- **Rationale**: Type-safe pipeline definition; camelCase serialization for API compatibility.
- **Acceptance criteria**:
  - `PipelineSpec.model_validate({"name": "test", "on": {"push": {"branches": ["main"]}}, "jobs": {"build": {"runs-on": "default", "steps": [{"run": "npm ci"}]}}})` succeeds.
  - `job.model_dump(by_alias=True)` produces `{"runs-on": "default", ...}`.
  - `steps` field accepts both `RunStep` and `UsesStep` via discriminated union.
- **Test vectors**: TV-TYPE-002, TV-TYPE-003
- **Notes**: `populate_by_name = True` on all models.

### TYPE-003
- **Priority**: P0
- **Statement**: The SDK MUST define Pydantic models for runtime objects: `Step`, `Job`, `Run`. Each MUST use `Field(alias=...)` for camelCase aliases (`run_id` -> `"runId"`, `job_key` -> `"jobKey"`, etc.).
- **Rationale**: Typed representation of server responses.
- **Acceptance criteria**:
  - `Run.model_validate({"id": "r1", "status": "queued", "trigger": {"type": "push"}, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z", "jobs": []})` succeeds.
  - `run.run_id` is not defined; field name is `id` (matching server).
  - `run.status` is a `RunStatus` enum value.
- **Test vectors**: TV-TYPE-004, TV-TYPE-005
- **Notes**: Run uses `id` (not `run_id`) to match server response for GET /runs/:runId.

### TYPE-004
- **Priority**: P0
- **Statement**: The SDK MUST define response models: `CreateRunResult`, `ListRunsResult`, `CancelRunResult`, `Artifact`, `ArtifactList`, `JobLogLine`, `JobLogs`, `RegisterRunnerResult`, `HeartbeatResult`. All MUST use camelCase aliases.
- **Rationale**: Typed response parsing.
- **Acceptance criteria**:
  - `CreateRunResult.model_validate({"runId": "r1", "status": "queued", "createdAt": "..."})` succeeds.
  - `ListRunsResult.model_validate({"runs": [], "nextCursor": null})` succeeds.
  - All fields accessible via snake_case Python names.
- **Test vectors**: TV-TYPE-006, TV-TYPE-007
- **Notes**: None.

### TYPE-005
- **Priority**: P0
- **Statement**: The SDK MUST define an exception hierarchy rooted at `CiFnError` with subclasses: `CiFnBadRequestError`, `CiFnUnauthorizedError`, `CiFnRunnerTokenInvalidError`, `CiFnPipelineInvalidError`, `CiFnRunCreateFailedError`, `CiFnRunNotFoundError`, `CiFnRunAlreadyFinishedError`, `CiFnRunnerNotFoundError`, `CiFnInternalError`, `CiFnConnectionError`. Each error subclass MUST have a class attribute `code` matching the corresponding `ErrorCode` enum value.
- **Rationale**: Error code to exception mapping for typed error handling.
- **Acceptance criteria**:
  - `CiFnRunNotFoundError.code == ErrorCode.RUN_NOT_FOUND`.
  - All `CiFnError` subclasses have `code`, `message`, and `details` attributes.
  - `CiFnConnectionError` is for network/transport errors (no server error code).
- **Test vectors**: TV-ENV-003, TV-ENV-004
- **Notes**: `CiFnError` base class has `code: ErrorCode`, `message: str`, `details: Optional[dict]`.

### TYPE-006
- **Priority**: P1
- **Statement**: All Pydantic models MUST set `model_config = ConfigDict(populate_by_name=True)` to accept both snake_case and camelCase field names in `model_validate()`.
- **Rationale**: Flexibility for users constructing models from either Python-style or JSON-style dicts.
- **Acceptance criteria**:
  - `CreateRunResult(run_id="r1", status="queued", created_at="...")` works.
  - `CreateRunResult(runId="r1", status="queued", createdAt="...")` works.
- **Test vectors**: TV-TYPE-008
- **Notes**: Use `ConfigDict` from pydantic v2.

### TYPE-007
- **Priority**: P1
- **Statement**: `StepSpec` MUST be defined as `Union[RunStep, UsesStep]` with a discriminator. A step is a `RunStep` if it has a `run` field, and a `UsesStep` if it has a `uses` field.
- **Rationale**: Clean deserialization of mixed step lists from the server.
- **Acceptance criteria**:
  - A list containing `{"run": "npm ci"}` and `{"uses": "checkout"}` deserializes to `[RunStep, UsesStep]`.
  - A step with neither `run` nor `uses` raises a validation error.
- **Test vectors**: TV-TYPE-009
- **Notes**: Use Pydantic discriminated union or custom validator.

---

## HTTP client methods

### CLIENT-001
- **Priority**: P0
- **Statement**: `CiFnClient.__init__` MUST create an `httpx.AsyncClient` with the configured `base_url`, `timeout`, and `verify` (from `verify_ssl`). The client MUST set a default `Authorization: Bearer <api_key>` header if `api_key` or `token` is configured.
- **Rationale**: Centralized HTTP client setup.
- **Acceptance criteria**:
  - Client created with `base_url="http://localhost:3100"` sends requests to that host.
  - Client with `api_key="abc"` sends `Authorization: Bearer abc` header.
  - Client with `verify_ssl=False` disables TLS verification.
- **Test vectors**: TV-CLIENT-001
- **Notes**: Use httpx's `base_url` and `headers` constructor params.

### CLIENT-002
- **Priority**: P0
- **Statement**: `create_run()` MUST send `POST /api/v1/runs` with body `{ pipelineSpec?, pipelineRef?, trigger: { type, payload? } }` serialized with camelCase aliases. MUST return `CreateRunResult` on success. MUST raise `CiFnPipelineInvalidError` on 422 with code `PIPELINE_INVALID`, `CiFnRunCreateFailedError` on 422 with code `RUN_CREATE_FAILED`, `CiFnBadRequestError` on 400.
- **Rationale**: Primary mutation endpoint.
- **Acceptance criteria**:
  - Valid pipeline spec + trigger creates run and returns `CreateRunResult` with `run_id` and `status="queued"`.
  - Invalid pipeline raises `CiFnPipelineInvalidError`.
  - Missing trigger raises `CiFnBadRequestError`.
- **Test vectors**: TV-CLIENT-002, TV-CLIENT-003, TV-CLIENT-004
- **Notes**: Either `pipeline_spec` or `pipeline_ref` should be provided; the server decides validation.

### CLIENT-003
- **Priority**: P0
- **Statement**: `list_runs()` MUST send `GET /api/v1/runs` with query params `limit`, `cursor`, `status` (when not None). `limit` MUST be clamped to range 1-100 before sending. MUST return `ListRunsResult`.
- **Rationale**: Run listing with pagination.
- **Acceptance criteria**:
  - `list_runs()` returns `ListRunsResult` with `runs` list.
  - `list_runs(limit=0)` sends `limit=1` (clamped).
  - `list_runs(limit=200)` sends `limit=100` (clamped).
  - `list_runs(status=RunStatus.QUEUED)` sends `?status=queued`.
  - `list_runs(cursor="abc")` sends `?cursor=abc`.
- **Test vectors**: TV-CLIENT-005, TV-CLIENT-006
- **Notes**: None.

### CLIENT-004
- **Priority**: P0
- **Statement**: `get_run()` MUST send `GET /api/v1/runs/:runId` and return `Run` on success. MUST raise `CiFnRunNotFoundError` on 404 with code `RUN_NOT_FOUND`.
- **Rationale**: Run detail retrieval.
- **Acceptance criteria**:
  - Valid run_id returns `Run` with jobs and steps.
  - Non-existent run_id raises `CiFnRunNotFoundError`.
- **Test vectors**: TV-CLIENT-007, TV-CLIENT-008
- **Notes**: None.

### CLIENT-005
- **Priority**: P0
- **Statement**: `cancel_run()` MUST send `POST /api/v1/runs/:runId/cancel` and return `CancelRunResult`. MUST raise `CiFnRunNotFoundError` on 404 and `CiFnRunAlreadyFinishedError` on 409.
- **Rationale**: Run cancellation.
- **Acceptance criteria**:
  - Cancelling a queued run returns `CancelRunResult` with `status="cancelled"`.
  - Cancelling a completed run raises `CiFnRunAlreadyFinishedError`.
  - Cancelling a non-existent run raises `CiFnRunNotFoundError`.
- **Test vectors**: TV-CLIENT-009, TV-CLIENT-010, TV-CLIENT-011
- **Notes**: None.

### CLIENT-006
- **Priority**: P0
- **Statement**: `get_job_logs()` MUST send `GET /api/v1/runs/:runId/jobs/:jobKey/logs` and return `JobLogs`. MUST raise `CiFnRunNotFoundError` on 404.
- **Rationale**: Log retrieval for debugging pipelines.
- **Acceptance criteria**:
  - Valid run_id + job_key returns `JobLogs` with `lines` list.
  - Non-existent run or job raises `CiFnRunNotFoundError`.
- **Test vectors**: TV-CLIENT-012, TV-CLIENT-013
- **Notes**: Logs MUST NOT contain secret values (server-side concern; SDK passes through).

### CLIENT-007
- **Priority**: P0
- **Statement**: `get_artifacts()` MUST send `GET /api/v1/runs/:runId/artifacts` and return `ArtifactList`. MUST raise `CiFnRunNotFoundError` on 404.
- **Rationale**: Artifact listing for build outputs.
- **Acceptance criteria**:
  - Valid run_id returns `ArtifactList` with artifact names and file IDs.
  - Non-existent run_id raises `CiFnRunNotFoundError`.
- **Test vectors**: TV-CLIENT-014, TV-CLIENT-015
- **Notes**: None.

### CLIENT-008
- **Priority**: P0
- **Statement**: `register_runner()` MUST send `POST /api/v1/runners/register` with body `{ token, labels? }`. MUST return `RegisterRunnerResult`. MUST raise `CiFnRunnerTokenInvalidError` on 401. The `token` parameter is the runner registration token, NOT the client's API key.
- **Rationale**: Runner registration from Python scripts.
- **Acceptance criteria**:
  - Valid token registers runner and returns `runner_id` and `runner_secret`.
  - Invalid token raises `CiFnRunnerTokenInvalidError`.
- **Test vectors**: TV-CLIENT-016, TV-CLIENT-017
- **Notes**: This endpoint does NOT use the client's API key for auth; it uses the registration token in the body.

### CLIENT-009
- **Priority**: P0
- **Statement**: `runner_heartbeat()` MUST send `POST /api/v1/runners/heartbeat` with body `{ runnerId }` and `Authorization: Bearer <runner_secret>` header (overriding the client's default auth). MUST return `HeartbeatResult`.
- **Rationale**: Runner job polling.
- **Acceptance criteria**:
  - Valid runner_id and runner_secret returns `HeartbeatResult` with optional `job` payload.
  - Invalid runner_secret raises `CiFnUnauthorizedError`.
- **Test vectors**: TV-CLIENT-018, TV-CLIENT-019
- **Notes**: `runner_secret` is passed as a method parameter, not the client's `api_key`.

### CLIENT-010
- **Priority**: P1
- **Statement**: `health()` MUST send `GET /health` (no auth header) and return `True` if the response is `{ "ok": true }`. MUST return `False` on any error (network, non-200, etc.) instead of raising.
- **Rationale**: Health check for monitoring; should not raise.
- **Acceptance criteria**:
  - Healthy server returns `True`.
  - Unreachable server returns `False`.
  - Server returning error returns `False`.
- **Test vectors**: TV-CLIENT-020, TV-CLIENT-021
- **Notes**: This is the only method that catches exceptions internally.

---

## Envelope handling and error mapping

### ENV-001
- **Priority**: P0
- **Statement**: The SDK MUST implement a private `_request()` method that: (a) sends the HTTP request via httpx, (b) parses the JSON response, (c) checks `ok` field, (d) on `ok: true` returns `data`, (e) on `ok: false` raises the mapped exception, (f) on network error raises `CiFnConnectionError`.
- **Rationale**: Centralized envelope handling.
- **Acceptance criteria**:
  - `ok: true` response returns parsed `data` dict.
  - `ok: false` response raises exception with correct code, message, details.
  - `httpx.ConnectError` raises `CiFnConnectionError`.
  - `httpx.TimeoutException` raises `CiFnConnectionError`.
  - Non-JSON response raises `CiFnError` with `INTERNAL_ERROR`.
- **Test vectors**: TV-ENV-001, TV-ENV-002, TV-ENV-003, TV-ENV-004, TV-ENV-005
- **Notes**: All public methods call `_request()` internally.

### ENV-002
- **Priority**: P0
- **Statement**: The error code to exception mapping MUST be: `BAD_REQUEST` -> `CiFnBadRequestError`, `UNAUTHORIZED` -> `CiFnUnauthorizedError`, `RUNNER_TOKEN_INVALID` -> `CiFnRunnerTokenInvalidError`, `PIPELINE_INVALID` -> `CiFnPipelineInvalidError`, `RUN_CREATE_FAILED` -> `CiFnRunCreateFailedError`, `RUN_NOT_FOUND` -> `CiFnRunNotFoundError`, `RUN_ALREADY_FINISHED` -> `CiFnRunAlreadyFinishedError`, `RUNNER_NOT_FOUND` -> `CiFnRunnerNotFoundError`, `INTERNAL_ERROR` -> `CiFnInternalError`. Unknown codes MUST raise `CiFnError` with the raw code string.
- **Rationale**: Deterministic exception mapping.
- **Acceptance criteria**:
  - Each error code maps to its corresponding exception class.
  - Unknown code `"SOMETHING_NEW"` raises `CiFnError` (base class).
- **Test vectors**: TV-ENV-003, TV-ENV-006
- **Notes**: Mapping defined as a dict constant.

### ENV-003
- **Priority**: P1
- **Statement**: All exception instances MUST include the HTTP status code as an `http_status` attribute in addition to `code`, `message`, and `details`.
- **Rationale**: Useful for debugging; some callers may want to inspect HTTP status.
- **Acceptance criteria**:
  - `except CiFnRunNotFoundError as e: assert e.http_status == 404`.
  - `except CiFnBadRequestError as e: assert e.http_status == 400`.
- **Test vectors**: TV-ENV-007
- **Notes**: None.

---

## Sync wrappers

### SYNC-001
- **Priority**: P1
- **Statement**: The SDK MUST provide sync versions of all public async methods: `create_run_sync`, `list_runs_sync`, `get_run_sync`, `cancel_run_sync`, `get_job_logs_sync`, `get_artifacts_sync`, `register_runner_sync`, `runner_heartbeat_sync`, `health_sync`. Each MUST call its async counterpart via `asyncio.run()` or a managed event loop.
- **Rationale**: Convenience for scripts and non-async codebases.
- **Acceptance criteria**:
  - `client.create_run_sync(trigger=TriggerInput(type=TriggerType.PUSH))` works without `await`.
  - Result is identical to `await client.create_run(...)`.
- **Test vectors**: TV-SYNC-001
- **Notes**: Use a private helper to run async in sync context, handling the case where an event loop is already running.

### SYNC-002
- **Priority**: P1
- **Statement**: Sync wrappers MUST handle the case where an event loop is already running (e.g. Jupyter notebooks) by using a new thread with its own event loop.
- **Rationale**: Common use case in data science environments.
- **Acceptance criteria**:
  - Calling `create_run_sync()` inside an already-running event loop does not raise `RuntimeError`.
- **Test vectors**: TV-SYNC-002
- **Notes**: Use `concurrent.futures.ThreadPoolExecutor` or `nest_asyncio` pattern.

---

## Security

### SEC-001
- **Priority**: P0
- **Statement**: `CiFnConfig.__repr__` and `CiFnConfig.__str__` MUST redact `api_key` and `token` fields.
- **Rationale**: Prevent credential leakage.
- **Acceptance criteria**:
  - `str(CiFnConfig(api_key="secret"))` does not contain `"secret"`.
- **Test vectors**: TV-SEC-001
- **Notes**: Display as `"***"` or `"<redacted>"`.

### SEC-002
- **Priority**: P0
- **Statement**: Exception messages MUST NOT include the authentication token. Exception messages SHOULD include the error code, server message, and run_id / endpoint path for debugging.
- **Rationale**: Error messages may be logged; tokens must not leak.
- **Acceptance criteria**:
  - `str(CiFnUnauthorizedError(...))` does not contain the token value.
  - `str(CiFnRunNotFoundError(...))` contains the error code and message from the server.
- **Test vectors**: TV-SEC-002
- **Notes**: None.

### SEC-003
- **Priority**: P1
- **Statement**: The SDK MUST NOT disable TLS verification by default. `verify_ssl=False` MUST only be settable explicitly in config.
- **Rationale**: Secure defaults.
- **Acceptance criteria**:
  - Default config has `verify_ssl=True`.
  - `CiFnConfig(verify_ssl=False)` disables verification.
- **Test vectors**: TV-SEC-003
- **Notes**: For local development / self-signed certs only.

---

## Testing

### TEST-001
- **Priority**: P0
- **Statement**: The test suite MUST include unit tests for: all Pydantic model validation (positive and negative), all enum definitions, exception hierarchy, config redaction. Tests MUST use `pytest` and `pytest-asyncio`.
- **Rationale**: Type system is the foundation; must be correct.
- **Acceptance criteria**:
  - `pytest tests/test_types.py` passes.
  - Tests cover valid and invalid model inputs.
- **Test vectors**: All TV-TYPE-*, TV-CFG-*, TV-SEC-*
- **Notes**: No network calls; pure model validation.

### TEST-002
- **Priority**: P0
- **Statement**: The test suite MUST include integration-style tests for all client methods using `httpx` mock transport (no real server needed). Each method MUST have at least one success case and one error case.
- **Rationale**: Verify HTTP client behavior without a running server.
- **Acceptance criteria**:
  - `pytest tests/test_client.py` passes.
  - Each client method has success + error test.
  - Mock transport returns appropriate envelopes.
- **Test vectors**: All TV-CLIENT-*, TV-ENV-*
- **Notes**: Use `httpx.MockTransport` or `respx` library.

### TEST-003
- **Priority**: P1
- **Statement**: The test suite MUST include tests for sync wrappers verifying they produce the same results as async methods.
- **Rationale**: Ensure sync/async parity.
- **Acceptance criteria**:
  - `pytest tests/test_sync.py` passes.
  - Sync wrapper test uses same mock transport as async test.
- **Test vectors**: TV-SYNC-001, TV-SYNC-002
- **Notes**: None.
