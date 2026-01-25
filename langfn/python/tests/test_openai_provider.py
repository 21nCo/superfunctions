import json

import httpx
import pytest

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
