"""Tests for CiFnClient (TV-CLIENT-*, TV-CFG-*, TV-ENV-*, TV-SEC-*)."""

from __future__ import annotations

import httpx
import pytest

from cifn.client import CiFnClient, CiFnConfig, create_cifn
from cifn.errors import (
    CiFnBadRequestError,
    CiFnConnectionError,
    CiFnError,
    CiFnPipelineInvalidError,
    CiFnRunAlreadyFinishedError,
    CiFnRunnerTokenInvalidError,
    CiFnRunNotFoundError,
)
from cifn.types import (
    JobSpec,
    OnPush,
    OnTriggers,
    PipelineSpec,
    RunStatus,
    RunStep,
    TriggerInput,
    TriggerType,
)
from tests.conftest import make_client, mock_transport

# --- TV-CFG-001, TV-CFG-002, TV-CFG-003 ---


def test_config_defaults() -> None:
    config = CiFnConfig()
    assert config.base_url == "http://localhost:3100"
    assert config.api_key is None
    assert config.token is None
    assert config.timeout == 30.0
    assert config.verify_ssl is True


def test_config_with_api_key() -> None:
    config = CiFnConfig(api_key="test-key-123")
    assert config.api_key == "test-key-123"
    assert config.effective_token == "test-key-123"


def test_config_api_key_takes_precedence() -> None:
    config = CiFnConfig(api_key="key-a", token="key-b")
    assert config.effective_token == "key-a"


# --- TV-CFG-004 ---


def test_create_cifn_returns_client() -> None:
    client = create_cifn(CiFnConfig(base_url="http://my-server:3100"))
    assert isinstance(client, CiFnClient)


# --- TV-SEC-001 ---


def test_config_repr_redacts_credentials() -> None:
    r = repr(CiFnConfig(api_key="secret123"))
    assert "secret123" not in r
    assert "***" in r


# --- TV-CLIENT-001: auth header ---


@pytest.mark.asyncio
async def test_client_sends_auth_header() -> None:
    seen_headers: list[dict] = []

    def capture_handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(dict(request.headers))
        return httpx.Response(200, json={"ok": True, "data": {"runs": [], "nextCursor": None}})

    transport = httpx.MockTransport(capture_handler)
    client = make_client(transport, api_key="my-key")
    await client.list_runs()
    assert len(seen_headers) >= 1
    # Header keys may be normalized (e.g. lowercase)
    first = seen_headers[0]
    auth = first.get("Authorization") or first.get("authorization") or ""
    assert "Bearer my-key" in auth, f"Expected Bearer my-key in headers: {first}"


# --- TV-CLIENT-002: create_run success ---


@pytest.mark.asyncio
async def test_create_run_success() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runs"): (
                201,
                {
                    "ok": True,
                    "data": {
                        "runId": "run-1",
                        "status": "queued",
                        "createdAt": "2026-02-15T12:00:00Z",
                    },
                },
            )
        }
    )
    client = make_client(transport)
    result = await client.create_run(
        trigger=TriggerInput(type=TriggerType.PUSH),
        pipeline_spec=PipelineSpec(
            on=OnTriggers(push=OnPush(branches=["main"])),
            jobs={"build": JobSpec(runs_on="default", steps=[RunStep(run="echo hello")])},
        ),
    )
    assert result.run_id == "run-1"
    assert result.status == RunStatus.QUEUED


# --- TV-CLIENT-003, TV-CLIENT-004 ---


@pytest.mark.asyncio
async def test_create_run_pipeline_invalid() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runs"): (
                422,
                {
                    "ok": False,
                    "error": {
                        "code": "PIPELINE_INVALID",
                        "message": "Pipeline validation failed: missing jobs",
                    },
                },
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnPipelineInvalidError) as exc_info:
        await client.create_run(
            trigger=TriggerInput(type=TriggerType.PUSH),
            pipeline_spec=PipelineSpec(on=OnTriggers(), jobs={}),
        )
    assert "PIPELINE_INVALID" in str(exc_info.value.code)


@pytest.mark.asyncio
async def test_create_run_bad_request() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runs"): (
                400,
                {"ok": False, "error": {"code": "BAD_REQUEST", "message": "Missing trigger field"}},
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnBadRequestError):
        await client.create_run(
            trigger=TriggerInput(type=TriggerType.PUSH),
            pipeline_spec=PipelineSpec(
                on=OnTriggers(push=OnPush(branches=["main"])),
                jobs={"b": JobSpec(runs_on="x", steps=[])},
            ),
        )


# --- TV-CLIENT-005, TV-CLIENT-006 ---


@pytest.mark.asyncio
async def test_list_runs_defaults() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs"): (
                200,
                {"ok": True, "data": {"runs": [], "nextCursor": None}},
            )
        }
    )
    client = make_client(transport)
    result = await client.list_runs()
    assert result.runs == []
    assert result.next_cursor is None


@pytest.mark.asyncio
async def test_list_runs_limit_clamping() -> None:
    params_captured: list[dict] = []

    def capture_params(request: httpx.Request) -> httpx.Response:
        params_captured.append(dict(request.url.params))
        return httpx.Response(200, json={"ok": True, "data": {"runs": [], "nextCursor": None}})

    transport = httpx.MockTransport(capture_params)
    client = make_client(transport)
    await client.list_runs(limit=500)
    assert params_captured[0].get("limit") == "100"
    params_captured.clear()
    await client.list_runs(limit=0)
    assert params_captured[0].get("limit") == "1"


# --- TV-CLIENT-007, TV-CLIENT-008 ---


@pytest.mark.asyncio
async def test_get_run_success() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/run-abc"): (
                200,
                {
                    "ok": True,
                    "data": {
                        "id": "run-abc",
                        "trigger": {"type": "push"},
                        "status": "success",
                        "createdAt": "2026-02-15T10:00:00Z",
                        "updatedAt": "2026-02-15T10:01:00Z",
                        "jobs": [],
                    },
                },
            )
        }
    )
    client = make_client(transport)
    run = await client.get_run("run-abc")
    assert run.id == "run-abc"
    assert run.status == RunStatus.SUCCESS


@pytest.mark.asyncio
async def test_get_run_not_found() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/nonexistent"): (
                404,
                {"ok": False, "error": {"code": "RUN_NOT_FOUND", "message": "Run not found"}},
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunNotFoundError):
        await client.get_run("nonexistent")


# --- TV-CLIENT-009, TV-CLIENT-010, TV-CLIENT-011 ---


@pytest.mark.asyncio
async def test_cancel_run_success() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runs/run-abc/cancel"): (
                200,
                {"ok": True, "data": {"runId": "run-abc", "status": "cancelled"}},
            )
        }
    )
    client = make_client(transport)
    result = await client.cancel_run("run-abc")
    assert result.status == RunStatus.CANCELLED


@pytest.mark.asyncio
async def test_cancel_run_already_finished() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runs/run-abc/cancel"): (
                409,
                {
                    "ok": False,
                    "error": {"code": "RUN_ALREADY_FINISHED", "message": "Run already completed"},
                },
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunAlreadyFinishedError):
        await client.cancel_run("run-abc")


@pytest.mark.asyncio
async def test_cancel_run_not_found() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runs/run-xyz/cancel"): (
                404,
                {"ok": False, "error": {"code": "RUN_NOT_FOUND", "message": "Run not found"}},
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunNotFoundError):
        await client.cancel_run("run-xyz")


# --- TV-CLIENT-012, TV-CLIENT-013 ---


@pytest.mark.asyncio
async def test_get_job_logs_success() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/r1/jobs/build/logs"): (
                200,
                {
                    "ok": True,
                    "data": {
                        "lines": [
                            {
                                "line": "Building...",
                                "timestamp": "2026-02-15T10:00:01Z",
                                "stepKey": "step-0",
                            }
                        ]
                    },
                },
            )
        }
    )
    client = make_client(transport)
    logs = await client.get_job_logs("r1", "build")
    assert len(logs.lines) == 1
    assert logs.lines[0].line == "Building..."


@pytest.mark.asyncio
async def test_get_job_logs_not_found() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/r1/jobs/build/logs"): (
                404,
                {
                    "ok": False,
                    "error": {"code": "RUN_NOT_FOUND", "message": "Run or job not found"},
                },
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunNotFoundError):
        await client.get_job_logs("r1", "build")


# --- TV-CLIENT-014, TV-CLIENT-015 ---


@pytest.mark.asyncio
async def test_get_artifacts_success() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/r1/artifacts"): (
                200,
                {"ok": True, "data": {"artifacts": [{"name": "dist", "fileId": "file-1"}]}},
            )
        }
    )
    client = make_client(transport)
    result = await client.get_artifacts("r1")
    assert len(result.artifacts) == 1
    assert result.artifacts[0].name == "dist"


@pytest.mark.asyncio
async def test_get_artifacts_not_found() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/r1/artifacts"): (
                404,
                {"ok": False, "error": {"code": "RUN_NOT_FOUND", "message": "Run not found"}},
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunNotFoundError):
        await client.get_artifacts("r1")


# --- TV-CLIENT-016, TV-CLIENT-017 ---


@pytest.mark.asyncio
async def test_register_runner_success() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runners/register"): (
                200,
                {"ok": True, "data": {"runnerId": "runner-1", "runnerSecret": "secret-abc"}},
            )
        }
    )
    client = make_client(transport)
    result = await client.register_runner("reg-token")
    assert result.runner_id == "runner-1"
    assert result.runner_secret == "secret-abc"


@pytest.mark.asyncio
async def test_register_runner_invalid_token() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runners/register"): (
                401,
                {
                    "ok": False,
                    "error": {
                        "code": "RUNNER_TOKEN_INVALID",
                        "message": "Invalid registration token",
                    },
                },
            )
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunnerTokenInvalidError):
        await client.register_runner("bad-token")


# --- TV-CLIENT-018, TV-CLIENT-019 ---


@pytest.mark.asyncio
async def test_runner_heartbeat_with_job() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runners/heartbeat"): (
                200,
                {"ok": True, "data": {"job": {"runId": "r1", "jobKey": "build", "jobSpec": {}}}},
            )
        }
    )
    client = make_client(transport)
    result = await client.runner_heartbeat("runner-1", "runner-secret")
    assert result.job is not None
    assert result.job.get("runId") == "r1"


@pytest.mark.asyncio
async def test_runner_heartbeat_no_job() -> None:
    transport = mock_transport(
        {
            ("POST", "/api/v1/runners/heartbeat"): (200, {"ok": True, "data": {"job": None}}),
        }
    )
    client = make_client(transport)
    result = await client.runner_heartbeat("runner-1", "runner-secret")
    assert result.job is None


# --- TV-CLIENT-020, TV-CLIENT-021 ---


@pytest.mark.asyncio
async def test_health_success() -> None:
    transport = mock_transport({("GET", "/health"): (200, {"ok": True})})
    client = make_client(transport)
    ok = await client.health()
    assert ok is True


@pytest.mark.asyncio
async def test_health_failure_returns_false() -> None:
    transport = mock_transport({("GET", "/health"): (500, {"ok": False})})
    client = make_client(transport)
    ok = await client.health()
    assert ok is False


# --- TV-ENV-001, TV-ENV-002 (via get_run), TV-ENV-004, TV-ENV-005 ---


@pytest.mark.asyncio
async def test_envelope_success_returns_data() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/r1"): (
                200,
                {
                    "ok": True,
                    "data": {
                        "id": "r1",
                        "trigger": {"type": "push"},
                        "status": "queued",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                        "jobs": [],
                    },
                },
            )
        }
    )
    client = make_client(transport)
    run = await client.get_run("r1")
    assert run.id == "r1"


@pytest.mark.asyncio
async def test_connection_error_raises() -> None:
    def fail(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")

    transport = httpx.MockTransport(fail)
    client = make_client(transport)
    with pytest.raises(CiFnConnectionError):
        await client.get_run("r1")


@pytest.mark.asyncio
async def test_non_json_raises_internal_error() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/r1"): (200, b"<html>Not JSON</html>"),
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnError) as exc_info:
        await client.get_run("r1")
    assert exc_info.value.code == "INTERNAL_ERROR"


# --- Context manager ---


@pytest.mark.asyncio
async def test_context_manager() -> None:
    transport = mock_transport(
        {("GET", "/api/v1/runs"): (200, {"ok": True, "data": {"runs": [], "nextCursor": None}})}
    )
    async with make_client(transport) as client:
        result = await client.list_runs()
        assert result.runs == []


# --- TV-ENV-007: http_status on exception ---


@pytest.mark.asyncio
async def test_exception_has_http_status() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/x"): (
                404,
                {"ok": False, "error": {"code": "RUN_NOT_FOUND", "message": "Not found"}},
            ),
        }
    )
    client = make_client(transport)
    with pytest.raises(CiFnRunNotFoundError) as exc_info:
        await client.get_run("x")
    assert exc_info.value.http_status == 404
