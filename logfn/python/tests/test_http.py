import asyncio
from typing import Any

import pytest

pytest.importorskip("superfunctions.http")
pytest.importorskip("superfunctions_fastapi")
pytest.importorskip("superfunctions_flask")
from fastapi import FastAPI
from fastapi.testclient import TestClient
from flask import Flask
from superfunctions.http import (
    BadRequestError,
    HttpMethod,
    Request,
    Response,
    Route,
    RouteContext,
    SetCookie,
)

from logfn import LogEvent, Logger
from logfn.http import get_request_logger, request_logger

fastapi_adapter = pytest.importorskip("superfunctions_fastapi")
flask_adapter = pytest.importorskip("superfunctions_flask")

TRACE = "0af7651916cd43dd8448eb211c80319c"
SPAN = "b7ad6b7169203331"


@pytest.mark.parametrize("framework", ["fastapi", "flask"])
@pytest.mark.parametrize("sample", [0, 1])
@pytest.mark.parametrize("status", [200, 503])
def test_real_framework_correlation(framework: str, sample: float, status: int) -> None:
    events: list[LogEvent] = []
    root = Logger("http", sinks=[events.extend])
    middleware = request_logger(logger=root, sample=sample, redact_headers=["x-private"])
    original = Response(
        status=status,
        body={"ok": True},
        headers={"X-Request-Id": "stale", "x-other": "kept"},
        cookies=[SetCookie(name="a", value="1"), SetCookie(name="b", value="2")],
    )

    async def handler(request: Request, context: RouteContext) -> Response:
        request_log = get_request_logger()
        assert request_log is not None
        request_log.info("application")
        assert await request.body() == b"unchanged body"
        return original

    routes = [Route(method=HttpMethod.POST, path="/", handler=handler, middleware=[middleware])]
    incoming = {
        "traceparent": f"00-{TRACE}-{SPAN}-01",
        "authorization": "private",
        "cookie": "secret=private",
        "x-private": "private",
    }
    app: Any
    client: Any
    response: Any
    if framework == "fastapi":
        app = FastAPI()
        app.include_router(fastapi_adapter.create_router(routes))
        with TestClient(app) as client:
            response = client.post("/", headers=incoming, content=b"unchanged body")
            cookies = response.headers.get_list("set-cookie")
    else:
        app = Flask(__name__)
        app.register_blueprint(flask_adapter.create_blueprint(routes))
        with app.test_client() as client:
            response = client.post("/", headers=incoming, data=b"unchanged body")
            cookies = response.headers.getlist("set-cookie")
    assert response.status_code == status
    assert len(cookies) == 2
    assert response.headers["x-other"] == "kept"
    assert original.headers["X-Request-Id"] == "stale"
    assert response.headers["x-trace-id"] == TRACE
    assert response.headers["x-span-id"] == SPAN
    assert len(response.headers["x-request-id"]) == 32
    assert len(events) == (3 if sample else 1)
    assert all(event["requestId"] == response.headers["x-request-id"] for event in events)
    if sample:
        assert events[0]["ctx"]["headers"]["authorization"] == "[redacted]"
        assert events[0]["ctx"]["headers"]["x-private"] == "[redacted]"
    assert get_request_logger() is None


@pytest.mark.parametrize("framework", ["fastapi", "flask"])
@pytest.mark.parametrize("error", [BadRequestError("bad input"), RuntimeError("private exception")])
def test_thrown_errors_remain_owned_by_adapter(framework: str, error: Exception) -> None:
    events: list[LogEvent] = []

    async def handler(request: Request, context: RouteContext) -> Response:
        raise error

    routes = [
        Route(
            method=HttpMethod.GET,
            path="/",
            handler=handler,
            middleware=[request_logger(logger=Logger("errors", sinks=[events.extend]))],
        )
    ]
    app: Any
    client: Any
    response: Any
    if framework == "fastapi":
        app = FastAPI()
        app.include_router(fastapi_adapter.create_router(routes))
        with TestClient(app) as client:
            response = client.get("/")
    else:
        app = Flask(__name__)
        app.register_blueprint(flask_adapter.create_blueprint(routes))
        with app.test_client() as client:
            response = client.get("/")
    assert response.status_code == (400 if isinstance(error, BadRequestError) else 500)
    assert "x-request-id" not in response.headers
    assert events[-1]["msg"] == "Request failed"
    assert "private exception" not in repr(events)
    assert get_request_logger() is None


class FakeRequest:
    method = "GET"
    path = "/"
    query_params: dict[str, Any] = {}

    def __init__(self, trace: str = "invalid-private") -> None:
        self.headers = {"TraceParent": trace}

    async def body(self) -> bytes:
        raise AssertionError("body must not be read")

    async def json(self) -> Any:
        raise AssertionError("body must not be read")

    async def text(self) -> str:
        raise AssertionError("body must not be read")


@pytest.mark.asyncio
async def test_concurrent_context_cancellation_nested_reset_and_invalid_trace() -> None:
    events: list[LogEvent] = []
    middleware = request_logger(logger=Logger("context", sinks=[events.extend]))
    context = RouteContext(url="http://local/", method="GET")
    entered = asyncio.Event()
    release = asyncio.Event()

    async def waiting(request: Request, current: RouteContext) -> Response:
        assert current is context
        first = get_request_logger()
        entered.set()
        await release.wait()
        assert get_request_logger() is first
        return Response()

    first = asyncio.ensure_future(middleware(FakeRequest(), context, waiting))
    await entered.wait()
    assert get_request_logger() is None

    async def nested(request: Request, current: RouteContext) -> Response:
        outer = get_request_logger()

        async def inner(_request: Request, _context: RouteContext) -> Response:
            assert get_request_logger() is not outer
            return Response()

        await middleware(request, current, inner)
        assert get_request_logger() is outer
        return Response()

    second = await middleware(FakeRequest(), context, nested)
    assert second.headers["x-trace-id"] != "invalid-private"
    assert len(second.headers["x-trace-id"]) == 32
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert get_request_logger() is None
    assert events[-1]["msg"] == "Request failed"


@pytest.mark.parametrize("sample", [-1, 2, float("nan"), float("inf"), True, "1"])
def test_sample_validation(sample: Any) -> None:
    with pytest.raises(ValueError):
        request_logger(sample=sample)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "incoming,accepted",
    [
        (f"00-{TRACE}-{SPAN}-01", True),
        (f"01-{TRACE}-{SPAN}-03-extension", True),
        (f"00-{TRACE}-{SPAN}-01-extra", False),
        (f"ff-{TRACE}-{SPAN}-01", False),
        (f'00-{"0" * 32}-{SPAN}-01', False),
        (f'00-{TRACE}-{"0" * 16}-01', False),
        (f"00-{TRACE.upper()}-{SPAN}-01", False),
        (f"00-{TRACE}-{SPAN}-01\n", False),
    ],
)
async def test_trace_context_vectors(incoming: str, accepted: bool) -> None:
    events: list[LogEvent] = []

    async def handler(request: Request, context: RouteContext) -> Response:
        return Response()

    response = await request_logger(logger=Logger("vectors", sinks=[events.extend]))(
        FakeRequest(incoming), RouteContext(url="http://local/", method="GET"), handler
    )
    assert (response.headers["x-trace-id"] == TRACE) is accepted
    assert response.headers["x-request-id"] == events[0]["requestId"]


@pytest.mark.asyncio
async def test_capture_identity_cannot_override_correlation_or_bypass_default_privacy() -> None:
    events: list[LogEvent] = []

    async def handler(request: Request, context: RouteContext) -> Response:
        request_log = get_request_logger()
        assert request_log is not None
        request_log.info("application")
        return Response()

    middleware = request_logger(
        logger=Logger("privacy", sinks=[events.extend]),
        capture_user=lambda _: {
            "userId": "private-user",
            "tenantId": "private-tenant",
            "traceId": "override",
        },
    )
    response = await middleware(
        FakeRequest(), RouteContext(url="http://local/", method="GET"), handler
    )
    assert response.headers["x-trace-id"] != "override"
    assert "private-user" not in repr(events)
    assert "private-tenant" not in repr(events)
