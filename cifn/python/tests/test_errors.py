"""Tests for exception hierarchy and error code mapping (TV-ENV-*, TV-SEC-002)."""

from __future__ import annotations

import asyncio

import pytest

from cifn._sync import run_sync
from cifn.errors import (
    ERROR_CODE_MAP,
    CiFnBadRequestError,
    CiFnConnectionError,
    CiFnError,
    CiFnInternalError,
    CiFnPipelineInvalidError,
    CiFnRunAlreadyFinishedError,
    CiFnRunCreateFailedError,
    CiFnRunnerNotFoundError,
    CiFnRunnerTokenInvalidError,
    CiFnRunNotFoundError,
    CiFnUnauthorizedError,
    raise_for_error,
)
from cifn.types import ErrorCode

# --- TYPE-005 / TV-ENV-003: Exception subclasses have correct code attribute ---


def test_run_not_found_error_code() -> None:
    assert CiFnRunNotFoundError.code == ErrorCode.RUN_NOT_FOUND


def test_each_exception_subclass_has_correct_code() -> None:
    assert CiFnBadRequestError.code == ErrorCode.BAD_REQUEST
    assert CiFnUnauthorizedError.code == ErrorCode.UNAUTHORIZED
    assert CiFnRunnerTokenInvalidError.code == ErrorCode.RUNNER_TOKEN_INVALID
    assert CiFnPipelineInvalidError.code == ErrorCode.PIPELINE_INVALID
    assert CiFnRunCreateFailedError.code == ErrorCode.RUN_CREATE_FAILED
    assert CiFnRunNotFoundError.code == ErrorCode.RUN_NOT_FOUND
    assert CiFnRunAlreadyFinishedError.code == ErrorCode.RUN_ALREADY_FINISHED
    assert CiFnRunnerNotFoundError.code == ErrorCode.RUNNER_NOT_FOUND
    assert CiFnInternalError.code == ErrorCode.INTERNAL_ERROR


def test_connection_error_has_no_code_attribute() -> None:
    e = CiFnConnectionError("Connection refused")
    assert getattr(e, "code", None) is None


# --- ERROR_CODE_MAP maps all ErrorCode enum values ---


def test_error_code_map_has_all_error_codes() -> None:
    for ec in ErrorCode:
        assert ec.value in ERROR_CODE_MAP
        assert ERROR_CODE_MAP[ec.value] is not None


# --- raise_for_error raises correct subclass (TV-ENV-003) ---


@pytest.mark.parametrize(
    "code,exc_cls",
    [
        (ErrorCode.BAD_REQUEST.value, CiFnBadRequestError),
        (ErrorCode.UNAUTHORIZED.value, CiFnUnauthorizedError),
        (ErrorCode.RUNNER_TOKEN_INVALID.value, CiFnRunnerTokenInvalidError),
        (ErrorCode.PIPELINE_INVALID.value, CiFnPipelineInvalidError),
        (ErrorCode.RUN_CREATE_FAILED.value, CiFnRunCreateFailedError),
        (ErrorCode.RUN_NOT_FOUND.value, CiFnRunNotFoundError),
        (ErrorCode.RUN_ALREADY_FINISHED.value, CiFnRunAlreadyFinishedError),
        (ErrorCode.RUNNER_NOT_FOUND.value, CiFnRunnerNotFoundError),
        (ErrorCode.INTERNAL_ERROR.value, CiFnInternalError),
    ],
)
def test_raise_for_error_raises_correct_subclass(code: str, exc_cls: type[CiFnError]) -> None:
    with pytest.raises(exc_cls) as exc_info:
        raise_for_error(code, "test message", http_status=400)
    assert exc_info.value.message == "test message"


# --- TV-ENV-006: Unknown error code raises base CiFnError ---


def test_raise_for_error_unknown_code_raises_base() -> None:
    with pytest.raises(CiFnError) as exc_info:
        raise_for_error("SOMETHING_NEW", "unknown", http_status=500)
    assert exc_info.value.code == "SOMETHING_NEW"
    assert not isinstance(exc_info.value, CiFnRunNotFoundError)


# --- CiFnError attributes: code, message, details, http_status (TV-ENV-007) ---


def test_cifn_error_attributes() -> None:
    e = CiFnRunNotFoundError(
        code=ErrorCode.RUN_NOT_FOUND.value,
        message="Run not found",
        details={"runId": "r1"},
        http_status=404,
    )
    assert e.code == ErrorCode.RUN_NOT_FOUND.value
    assert e.message == "Run not found"
    assert e.details == {"runId": "r1"}
    assert e.http_status == 404


def test_raise_for_error_sets_http_status() -> None:
    with pytest.raises(CiFnRunNotFoundError) as exc_info:
        raise_for_error("RUN_NOT_FOUND", "Not found", http_status=404)
    assert exc_info.value.http_status == 404


# --- TV-SEC-002: str(exception) includes code and message but NOT tokens ---


def test_exception_str_includes_code_and_message() -> None:
    e = CiFnRunNotFoundError(
        code=ErrorCode.RUN_NOT_FOUND.value,
        message="Run not found",
        http_status=404,
    )
    s = str(e)
    assert "RUN_NOT_FOUND" in s
    assert "Run not found" in s


def test_exception_str_does_not_contain_token() -> None:
    # Simulate UNAUTHORIZED from server - we never put api_key in the exception
    e = CiFnUnauthorizedError(
        code=ErrorCode.UNAUTHORIZED.value,
        message="Invalid or missing token",
        http_status=401,
    )
    s = str(e)
    assert "secret" not in s.lower()
    assert "Invalid" in s or "token" in s.lower()


# --- run_sync helper (SYNC-002 partial) ---


async def _async_returns_value() -> str:
    return "ok"


def test_run_sync_no_loop() -> None:
    result = run_sync(_async_returns_value())
    assert result == "ok"


def test_run_sync_when_loop_already_running() -> None:
    result: list[str] = []

    async def outer() -> None:
        # Call run_sync from inside a running event loop (simulates Jupyter)
        r = run_sync(_async_returns_value())
        result.append(r)

    asyncio.run(outer())
    assert result == ["ok"]
