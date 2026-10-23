"""Exception hierarchy and error code mapping for CiFn API."""

from __future__ import annotations

from typing import Any, Dict, NoReturn, Optional, Type, cast

from cifn.types import ErrorCode


class CiFnError(Exception):
    """Base exception for CiFn API errors. Server returned ok: false with an error payload."""

    def __init__(
        self,
        code: Optional[str],
        message: str,
        details: Optional[Dict[str, Any]] = None,
        http_status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        self.http_status = http_status

    def __str__(self) -> str:
        parts = [f"code={self.code!r}", f"message={self.message!r}"]
        return " ".join(parts)


class CiFnBadRequestError(CiFnError):
    code = ErrorCode.BAD_REQUEST


class CiFnUnauthorizedError(CiFnError):
    code = ErrorCode.UNAUTHORIZED


class CiFnRunnerTokenInvalidError(CiFnError):
    code = ErrorCode.RUNNER_TOKEN_INVALID


class CiFnPipelineInvalidError(CiFnError):
    code = ErrorCode.PIPELINE_INVALID


class CiFnRunCreateFailedError(CiFnError):
    code = ErrorCode.RUN_CREATE_FAILED


class CiFnRunNotFoundError(CiFnError):
    code = ErrorCode.RUN_NOT_FOUND


class CiFnRunAlreadyFinishedError(CiFnError):
    code = ErrorCode.RUN_ALREADY_FINISHED


class CiFnRunnerNotFoundError(CiFnError):
    code = ErrorCode.RUNNER_NOT_FOUND


class CiFnInternalError(CiFnError):
    code = ErrorCode.INTERNAL_ERROR


class CiFnConnectionError(CiFnError):
    """Network/transport error (connection refused, timeout). No server error code."""

    code: None = None

    def __init__(self, message: str) -> None:
        super().__init__(code=None, message=message, http_status=None)


# Map server error code string -> exception class
ERROR_CODE_MAP: Dict[str, Type[CiFnError]] = {
    ErrorCode.BAD_REQUEST.value: CiFnBadRequestError,
    ErrorCode.UNAUTHORIZED.value: CiFnUnauthorizedError,
    ErrorCode.RUNNER_TOKEN_INVALID.value: CiFnRunnerTokenInvalidError,
    ErrorCode.PIPELINE_INVALID.value: CiFnPipelineInvalidError,
    ErrorCode.RUN_CREATE_FAILED.value: CiFnRunCreateFailedError,
    ErrorCode.RUN_NOT_FOUND.value: CiFnRunNotFoundError,
    ErrorCode.RUN_ALREADY_FINISHED.value: CiFnRunAlreadyFinishedError,
    ErrorCode.RUNNER_NOT_FOUND.value: CiFnRunnerNotFoundError,
    ErrorCode.INTERNAL_ERROR.value: CiFnInternalError,
}


def raise_for_error(
    code: str,
    message: str,
    details: Optional[Dict[str, Any]] = None,
    http_status: Optional[int] = None,
) -> NoReturn:
    """Raise the appropriate CiFnError subclass for the given server error code."""
    exc_cls = ERROR_CODE_MAP.get(code, CiFnError)
    if exc_cls is CiFnError:
        raise CiFnError(
            code=code,
            message=message,
            details=details,
            http_status=http_status,
        )
    # Known code: use class's code (ErrorCode) for the instance
    exc_code = cast(ErrorCode, getattr(exc_cls, "code", None))
    raise exc_cls(
        code=exc_code.value,
        message=message,
        details=details,
        http_status=http_status,
    )
