"""Optional shared HTTP middleware. Install logfn[http] on Python 3.10+."""

from __future__ import annotations

import math
import random
import re
import secrets
import time
from collections.abc import Mapping, Sequence
from contextvars import ContextVar
from typing import Callable

from superfunctions.http import Middleware, Request, RequestHandler, Response, RouteContext

from .core import Logger
from .sinks import SinkConsole
from .types import LogCorrelation

_request_logger: ContextVar[Logger | None] = ContextVar("logfn_request_logger", default=None)
_TRACE = re.compile(r"([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)")
_SECRET_HEADERS = frozenset(("authorization", "cookie", "x-api-key", "x-auth-token"))


def get_request_logger() -> Logger | None:
    """Request-scoped logger, or None outside middleware (async children inherit context)."""
    return _request_logger.get()


def _ids(headers: Mapping[str, str], header: str) -> LogCorrelation:
    match = _TRACE.fullmatch(headers.get(header, ""))
    trace, span = secrets.token_hex(16), secrets.token_hex(8)
    if match:
        version, candidate_trace, candidate_span, _flags, suffix = match.groups()
        if (
            version != "ff"
            and int(candidate_trace, 16) != 0
            and int(candidate_span, 16) != 0
            and (suffix == "" if version == "00" else suffix == "" or suffix.startswith("-"))
        ):
            trace, span = candidate_trace, candidate_span
    return {"traceId": trace, "spanId": span, "requestId": secrets.token_hex(16)}


def request_logger(
    *,
    logger: Logger | None = None,
    header: str = "traceparent",
    sample: float = 1.0,
    redact_headers: Sequence[str] = (),
    capture_user: Callable[[Request], LogCorrelation | None] | None = None,
) -> Middleware:
    """Correlate shared routes used by the existing FastAPI and Flask adapters.

    Sampling affects automatic logs only. Returned Responses receive IDs; exceptions
    propagate unchanged to their owning adapter. Bodies are never consumed. Logger
    delivery/flush stays host-owned; Flask's per-request loop requires synchronous sinks.
    """
    if (
        isinstance(sample, bool)
        or not isinstance(sample, (int, float))
        or not math.isfinite(sample)
        or not 0 <= sample <= 1
    ):
        raise ValueError("sample must be a finite number between zero and one")
    if not isinstance(header, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", header):
        raise ValueError("header must be a valid HTTP header name")
    if isinstance(redact_headers, (str, bytes)) or any(
        not isinstance(value, str) for value in redact_headers
    ):
        raise ValueError("redact_headers must be a sequence of header names")
    secret_headers = _SECRET_HEADERS.union(value.lower() for value in redact_headers)
    root = logger if logger is not None else Logger("logfn.http", sinks=[SinkConsole()])

    async def middleware(
        request: Request, context: RouteContext, next_handler: RequestHandler
    ) -> Response:
        started = time.monotonic()
        sampled = sample == 1 or (sample != 0 and random.random() < sample)
        headers = {key.lower(): value for key, value in request.headers.items()}
        ids = _ids(headers, header.lower())
        identity = (capture_user(request) or {}) if capture_user is not None else {}
        # Capture callbacks may supply identity, never override validated request IDs.
        correlation: LogCorrelation = {**ids}
        if "userId" in identity:
            correlation["userId"] = identity["userId"]
        if "tenantId" in identity:
            correlation["tenantId"] = identity["tenantId"]
        child = root.child(correlation=correlation)
        token = _request_logger.set(child)
        metadata = {"method": request.method, "path": request.path}
        try:
            if sampled:
                child.info(
                    "Request started",
                    {
                        **metadata,
                        "headers": {
                            key: "[redacted]" if key in secret_headers else value
                            for key, value in headers.items()
                        },
                    },
                )
            try:
                response = await next_handler(request, context)
            except BaseException:
                if sampled:
                    child.info(
                        "Request failed",
                        {**metadata, "latencyMs": (time.monotonic() - started) * 1000},
                    )
                raise
            response_headers = {
                key: value
                for key, value in response.headers.items()
                if key.lower() not in ("x-request-id", "x-trace-id", "x-span-id")
            }
            response_headers.update(
                {
                    "x-request-id": ids["requestId"],
                    "x-trace-id": ids["traceId"],
                    "x-span-id": ids["spanId"],
                }
            )
            correlated = response.model_copy(update={"headers": response_headers})
            if sampled:
                child.info(
                    "Request completed",
                    {
                        **metadata,
                        "statusCode": response.status,
                        "contentLength": next(
                            (
                                value
                                for key, value in response.headers.items()
                                if key.lower() == "content-length"
                            ),
                            None,
                        ),
                        "latencyMs": (time.monotonic() - started) * 1000,
                    },
                )
            return correlated
        finally:
            _request_logger.reset(token)

    return middleware
