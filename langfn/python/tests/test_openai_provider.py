import json

import httpx
import pytest

from langfn.core.errors import ProviderAuthError, RateLimitError
from langfn.core.types import ChatRequest, CompletionRequest
from langfn.models import OpenAIChatModel


@pytest.mark.asyncio
async def test_openai_chat_parses_response_and_usage():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content.decode("utf-8"))
        assert body["model"] == "gpt-4o-mini"
        assert body["messages"][0]["role"] == "user"
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "hi"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            },
        )

    transport = httpx.MockTransport(handler)
    model = OpenAIChatModel(api_key="sk-test", base_url="https://api.openai.com/v1", transport=transport)
    resp = await model.complete(CompletionRequest(prompt="x", metadata={}))
    assert resp.content == "hi"
    assert resp.usage.prompt_tokens == 3
    assert resp.usage.completion_tokens == 2


@pytest.mark.asyncio
async def test_openai_chat_parses_tool_calls():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {"name": "add", "arguments": "{\"a\":2,\"b\":3}"},
                                }
                            ],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    transport = httpx.MockTransport(handler)
    model = OpenAIChatModel(api_key="sk-test", base_url="https://api.openai.com/v1", transport=transport)
    resp = await model.chat(ChatRequest(messages=[{"role": "user", "content": "x"}], metadata={}))
    assert resp.tool_calls is not None
    assert resp.tool_calls[0].name == "add"
    assert resp.tool_calls[0].arguments == {"a": 2, "b": 3}


@pytest.mark.asyncio
async def test_openai_stream_yields_content_events():
    stream_body = "\n".join(
        [
            'data: {"choices":[{"delta":{"content":"he"}}]}',
            'data: {"choices":[{"delta":{"content":"llo"}}]}',
            "data: [DONE]",
            "",
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, content=stream_body.encode("utf-8"), headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    model = OpenAIChatModel(api_key="sk-test", base_url="https://api.openai.com/v1", transport=transport)

    events = [e async for e in model.stream(CompletionRequest(prompt="x", metadata={}))]
    assert [e.type for e in events] == ["content", "content", "end"]
    assert events[0].content == "he"
    assert events[1].content == "llo"


@pytest.mark.asyncio
async def test_openai_normalizes_auth_and_rate_limit_errors():
    responses = iter(
        [
            httpx.Response(401, json={"error": {"message": "bad key"}}),
            httpx.Response(429, json={"error": {"message": "slow down"}}, headers={"retry-after": "2"}),
        ]
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return next(responses)

    model = OpenAIChatModel(api_key="sk-test", transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderAuthError) as auth_error:
        await model.complete(CompletionRequest(prompt="x", metadata={}))
    assert auth_error.value.code == "PROVIDER_AUTH"

    with pytest.raises(RateLimitError) as rate_limit_error:
        await model.complete(CompletionRequest(prompt="x", metadata={}))
    assert rate_limit_error.value.code == "PROVIDER_RATE_LIMIT"
    assert rate_limit_error.value.retry_after == 2.0


def test_openai_transport_helper_reuses_clients():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ok"}}], "usage": {}}))
    model = OpenAIChatModel(api_key="sk-test", transport=transport)

    assert model._client() is model._client()
