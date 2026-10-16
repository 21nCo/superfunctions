"""Canonical BrowseFn errors and router envelope helpers."""

from typing import Any, Dict, Literal, Optional, TypedDict

BrowseFnErrorCode = Literal[
    "INVALID_ARGUMENT",
    "INVALID_URL",
    "UNSUPPORTED_PROVIDER",
    "UNSUPPORTED_PROVIDER_CAPABILITY",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_ERROR",
    "RATE_LIMITED",
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_NOT_FOUND",
    "DOWNLOAD_EXISTS",
    "DOWNLOAD_TOO_LARGE",
    "SECURITY_POLICY_BLOCKED",
    "CACHE_ERROR",
    "INTERNAL_ERROR",
]


class BrowseFnError(Exception):
    """Canonical machine-readable BrowseFn error."""

    def __init__(
        self,
        code: BrowseFnErrorCode,
        message: str,
        *,
        provider: Optional[str] = None,
        retry_after_ms: Optional[int] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.provider = provider
        self.retry_after_ms = retry_after_ms
        self.details = details


class SuccessEnvelopeMeta(TypedDict, total=False):
    requestId: str
    provider: str
    cached: bool
    durationMs: float
    fallbackFrom: str


class ErrorEnvelopeMeta(TypedDict):
    requestId: str


def create_success_envelope(data: Any, meta: SuccessEnvelopeMeta) -> Dict[str, Any]:
    return {
        "ok": True,
        "data": data,
        "meta": meta,
    }


def create_error_envelope(error: BrowseFnError, request_id: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": error.code,
            "message": error.message,
            "provider": error.provider,
            "retryAfterMs": error.retry_after_ms,
            "details": error.details,
        },
        "meta": {"requestId": request_id},
    }


def upstream_status(error: Exception) -> Optional[int]:
    values = [getattr(error, "status_code", None), getattr(error, "status", None),
              getattr(getattr(error, "response", None), "status_code", None),
              (getattr(error, "details", None) or {}).get("statusCode"), getattr(error, "code", None)]
    return next((value for value in values if isinstance(value, int) and 100 <= value <= 599), None)


def normalize_provider_error(error: Exception, provider: Optional[str] = None) -> BrowseFnError:
    if isinstance(error, BrowseFnError):
        return error
    import httpx
    status = upstream_status(error)
    code = "UPSTREAM_TIMEOUT" if isinstance(error, httpx.TimeoutException) or status in {408, 504} else "RATE_LIMITED" if status == 429 else "UPSTREAM_NOT_FOUND" if status == 404 else "PROVIDER_ERROR"
    return BrowseFnError(code, str(error), provider=provider, details={"statusCode": status} if status else None)
