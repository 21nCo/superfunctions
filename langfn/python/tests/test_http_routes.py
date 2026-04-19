import json
from typing import Any, Dict, Optional

import pytest

from langfn import LangFn
from langfn.core.errors import ValidationError
from langfn.core.types import CompletionResponse
from langfn.http import LangFnAuthConfig, LangFnRateLimitConfig, create_routes
from langfn.http.rate_limit import RateLimitDecision
from langfn.http.validation import LangFnRouteContext
from langfn.models import MockChatModel


class FakeRequest:
    def __init__(
        self,
        *,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        query_params: Optional[Dict[str, Any]] = None,
    ):
        self._method = method
        self._path = path
        self._body = body or {}
        self._headers = headers or {}
        self._query = query_params or {}

    @property
    def method(self) -> str:
        return self._method

    @property
    def path(self) -> str:
        return self._path

    @property
    def headers(self) -> Dict[str, str]:
        return self._headers

    @property
    def query_params(self) -> Dict[str, Any]:
        return self._query

    async def json(self) -> Any:
        return self._body

    async def body(self) -> bytes:
        return json.dumps(self._body).encode("utf-8")

    async def text(self) -> str:
        return json.dumps(self._body)


async def run_route(routes, request: FakeRequest):
    route = next(item for item in routes if item.method.value == request.method and item.path == request.path)
    context = LangFnRouteContext(
        params={},
        query=request.query_params,
        headers=request.headers,
        url=f"http://localhost{request.path}",
        method=request.method,
    )

    async def invoke_handler(current_request, current_context):
        return await route.handler(current_request, current_context)

    handler = invoke_handler
    for middleware in reversed(route.middleware or []):
        next_handler = handler

        async def wrapped(current_request, current_context, current_middleware=middleware, current_next=next_handler):
            return await current_middleware(current_request, current_context, current_next)

        handler = wrapped

    response = await handler(request, context)
    return response, context


@pytest.mark.asyncio
async def test_health_is_anonymous_and_canonical():
    routes = create_routes(LangFn(model=MockChatModel(responses=["ignored"])))
    response, _context = await run_route(routes, FakeRequest(method="GET", path="/health"))

    assert response.status == 200
    assert response.body == {
        "ok": True,
        "traceId": None,
        "data": {"status": "ok", "name": "langfn", "version": "0.1.0"},
        "error": None,
    }


@pytest.mark.asyncio
async def test_non_health_routes_require_auth():
    routes = create_routes(
        LangFn(model=MockChatModel(responses=["hello"])),
        auth=LangFnAuthConfig(validate_bearer_token=lambda _token, _request: None),
    )
    response, _context = await run_route(
        routes,
        FakeRequest(
            method="POST",
            path="/complete",
            body={"prompt": "hello"},
            headers={"authorization": "Bearer bad", "content-type": "application/json"},
        ),
    )

    assert response.status == 401
    assert response.body["error"]["code"] == "AUTH_REQUIRED"


@pytest.mark.asyncio
async def test_invalid_auth_session_payload_maps_to_auth_required():
    routes = create_routes(
        LangFn(model=MockChatModel(responses=["hello"])),
        auth=LangFnAuthConfig(validate_bearer_token=lambda _token, _request: {"id": "sess_1", "type": "bearer"}),
    )
    response, _context = await run_route(
        routes,
        FakeRequest(
            method="POST",
            path="/complete",
            body={"prompt": "hello"},
            headers={"authorization": "Bearer ok", "content-type": "application/json"},
        ),
    )

    assert response.status == 401
    assert response.body["error"]["code"] == "AUTH_REQUIRED"


@pytest.mark.asyncio
async def test_unexpected_auth_provider_errors_propagate():
    def broken_validator(_token, _request):
        raise RuntimeError("auth backend offline")

    routes = create_routes(
        LangFn(model=MockChatModel(responses=["hello"])),
        auth=LangFnAuthConfig(validate_bearer_token=broken_validator),
    )

    with pytest.raises(RuntimeError, match="auth backend offline"):
        await run_route(
            routes,
            FakeRequest(
                method="POST",
                path="/complete",
                body={"prompt": "hello"},
                headers={"authorization": "Bearer ok", "content-type": "application/json"},
            ),
        )


@pytest.mark.asyncio
async def test_validation_errors_use_canonical_code():
    routes = create_routes(
        LangFn(model=MockChatModel(responses=["hello"])),
        auth=LangFnAuthConfig(
            validate_bearer_token=lambda _token, _request: {
                "id": "sess_1",
                "type": "bearer",
                "subject": {"actorId": "user_1", "actorType": "user", "tenantId": "tenant_1"},
            }
        ),
    )
    response, _context = await run_route(
        routes,
        FakeRequest(
            method="POST",
            path="/complete",
            body={"prompt": ""},
            headers={"authorization": "Bearer ok", "content-type": "application/json"},
        ),
    )

    assert response.status == 400
    assert response.body["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_tenant_headers_flow_into_metadata_and_rate_limit_keys():
    observed: Dict[str, Any] = {}

    class RateLimiter:
        async def consume(self, payload: Dict[str, Any]) -> RateLimitDecision:
            observed["rate_limit_key"] = payload["key"]
            observed["tenant_context"] = payload["tenant_context"].model_dump(by_alias=True, exclude_none=True)
            return RateLimitDecision(allowed=True, key=payload["key"], remaining=4)

    async def complete_handler(request):
        observed["metadata"] = request.metadata
        return CompletionResponse(content="done")

    routes = create_routes(
        LangFn(model=MockChatModel(complete_handler=complete_handler)),
        auth=LangFnAuthConfig(
            validate_bearer_token=lambda _token, _request: {
                "id": "sess_1",
                "type": "bearer",
                "subject": {"actorId": "session_user", "actorType": "user", "tenantId": "session_tenant"},
            }
        ),
        rate_limit=LangFnRateLimitConfig(provider=RateLimiter()),
    )
    response, _context = await run_route(
        routes,
        FakeRequest(
            method="POST",
            path="/complete",
            body={"prompt": "hello", "metadata": {"source": "test"}},
            headers={
                "authorization": "Bearer ok",
                "content-type": "application/json",
                "x-tenant-id": "tenant_header",
                "x-user-id": "user_header",
                "x-run-id": "run_123",
                "x-conversation-id": "conv_456",
            },
        ),
    )

    assert response.status == 200
    assert response.body["ok"] is True
    assert response.body["data"]["content"] == "done"
    assert observed["rate_limit_key"] == "tenant_header:user_header:/complete"
    assert observed["tenant_context"] == {
        "tenantId": "tenant_header",
        "userId": "user_header",
        "runId": "run_123",
        "conversationId": "conv_456",
    }
    assert observed["metadata"] == {
        "source": "test",
        "tenantId": "tenant_header",
        "userId": "user_header",
        "runId": "run_123",
        "conversationId": "conv_456",
    }


@pytest.mark.asyncio
async def test_rate_limited_requests_return_canonical_error():
    class RateLimiter:
        async def consume(self, payload: Dict[str, Any]) -> RateLimitDecision:
            return RateLimitDecision(allowed=False, key=payload["key"], remaining=0, retry_after_ms=3000)

    routes = create_routes(
        LangFn(model=MockChatModel(responses=["hello"])),
        auth=LangFnAuthConfig(
            validate_bearer_token=lambda _token, _request: {
                "id": "sess_1",
                "type": "bearer",
                "subject": {"actorId": "user_1", "actorType": "user", "tenantId": "tenant_1"},
            }
        ),
        rate_limit=LangFnRateLimitConfig(provider=RateLimiter()),
    )
    response, _context = await run_route(
        routes,
        FakeRequest(
            method="POST",
            path="/chat",
            body={"messages": [{"role": "user", "content": "hello"}]},
            headers={"authorization": "Bearer ok", "content-type": "application/json"},
        ),
    )

    assert response.status == 429
    assert response.headers["retry-after"] == "3"
    assert response.body["error"]["code"] == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_stream_returns_sse_frames():
    routes = create_routes(
        LangFn(
            model=MockChatModel(
                streams=[
                    [
                        {"type": "content", "content": "hello", "delta": "hello"},
                        {"type": "token_usage", "prompt_tokens": 1, "completion_tokens": 1},
                        {"type": "end", "finish_reason": "stop"},
                    ]
                ]
            )
        ),
        auth=LangFnAuthConfig(
            validate_bearer_token=lambda _token, _request: {
                "id": "sess_1",
                "type": "bearer",
                "subject": {"actorId": "user_1", "actorType": "user", "tenantId": "tenant_1"},
            }
        ),
    )
    response, _context = await run_route(
        routes,
        FakeRequest(
            method="POST",
            path="/stream",
            body={"prompt": "stream please"},
            headers={"authorization": "Bearer ok", "content-type": "application/json"},
        ),
    )

    frames = [
        json.loads(chunk.replace("data: ", ""))
        for chunk in str(response.body).strip().split("\n\n")
        if chunk.strip()
    ]
    assert response.status == 200
    assert response.headers["content-type"] == "text/event-stream"
    assert frames[0]["type"] == "content"
    assert frames[0]["content"] == "hello"
    assert frames[0].get("trace_id")
    assert frames[-1]["type"] == "end"
