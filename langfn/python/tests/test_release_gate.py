from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx
from pydantic import BaseModel

from langfn import LangFn
from langfn.core.types import ChatRequest, CompletionRequest, ToolSpec
from langfn.http import create_routes
from langfn.http.validation import LangFnRouteContext
from langfn.mcp import MCPServer
from langfn.models import (
    AnthropicChatModel,
    GoogleChatModel,
    MistralChatModel,
    MockChatModel,
    OllamaChatModel,
    OpenAIChatModel,
)
from langfn.observability import Tracer
from langfn.tools import Tool


REPO_ROOT = Path(__file__).resolve().parents[3]
LANGFN_ROOT = REPO_ROOT / "langfn"
ABSOLUTE_PATH_PATTERN = re.compile(r'(^|[\s("\'`])(?:/Users/[^ \n\r\t"\')`]+|/home/[^ \n\r\t"\')`]+|[A-Za-z]:\\Users\\[^ \n\r\t"\')`]+)')


def _read(path: Path) -> str:
    return path.read_text()


def test_docs_and_gate_inventory_are_portable() -> None:
    root_readme = _read(LANGFN_ROOT / "README.md")
    py_readme = _read(LANGFN_ROOT / "python" / "README.md")
    compatibility = _read(LANGFN_ROOT / "COMPATIBILITY.md")
    release_gate = _read(LANGFN_ROOT / ".conduct" / "release-gate.md")
    package_json = json.loads((REPO_ROOT / "package.json").read_text())

    assert package_json["scripts"]["gate:langfn-release"] == "node scripts/gate-langfn-release.mjs"
    for content in (root_readme, py_readme, compatibility, release_gate):
        assert "0.1.0" in content
        assert not ABSOLUTE_PATH_PATTERN.search(content)
    assert "npm run gate:langfn-release" in root_readme
    assert "python3 -m pytest langfn/python/tests -q" in release_gate


def test_compatibility_matrix_lists_first_party_providers() -> None:
    compatibility = _read(LANGFN_ROOT / "COMPATIBILITY.md")

    assert "| openai | yes | yes | yes | yes | yes | yes |" in compatibility
    assert "| anthropic | yes | yes | yes | yes | no | yes |" in compatibility
    assert "| ollama | yes | yes | yes | no | no | yes |" in compatibility
    assert "| google | yes | yes | yes | no | no | yes |" in compatibility
    assert "| mistral | yes | yes | yes | yes | no | yes |" in compatibility


def test_cross_language_client_api_is_documented_in_both_sources() -> None:
    ts_client = _read(LANGFN_ROOT / "typescript" / "src" / "client.ts")
    py_client = _read(LANGFN_ROOT / "python" / "langfn" / "client.py")

    parity_pairs = [
        ("complete(", "async def complete("),
        ("chat(", "async def chat("),
        ("stream(", "async def stream("),
        ("streamSSE(", "async def stream_sse("),
        ("completeBatch(", "async def complete_batch("),
        ("embed(", "async def embed("),
        ("feedback(", "async def feedback("),
        ("getTraces(", "async def get_traces("),
        ("createToolAgent(", "def create_tool_agent("),
        ("createReactAgent(", "def create_react_agent("),
        ("createPlanExecuteAgent(", "def create_plan_execute_agent("),
        ("createPromptRegistry(", "def create_prompt_registry("),
        ("createRagChain(", "def create_rag_chain("),
    ]

    for ts_needle, py_needle in parity_pairs:
        assert ts_needle in ts_client
        assert py_needle in py_client


def test_provider_and_runtime_surfaces_are_smoke_ready() -> None:
    async def run() -> None:
        openai = OpenAIChatModel(api_key="sk-test", transport=httpx.MockTransport(_openai_handler))
        anthropic = AnthropicChatModel(api_key="sk-test", transport=httpx.MockTransport(_anthropic_handler))
        ollama = OllamaChatModel(transport=httpx.MockTransport(_ollama_handler))
        google = GoogleChatModel(api_key="google-test", transport=httpx.MockTransport(_google_handler))
        mistral = MistralChatModel(api_key="mistral-test", transport=httpx.MockTransport(_mistral_handler))

        openai_chat = await openai.chat(ChatRequest(messages=[{"role": "user", "content": "hi"}], tools=[_tool_spec()]))
        assert openai_chat.message.content == "openai-chat"
        assert openai_chat.tool_calls and openai_chat.tool_calls[0].name == "add"
        assert await _collect_stream(openai.stream(CompletionRequest(prompt="hi"))) == ["openai-stream"]

        anthropic_chat = await anthropic.chat(ChatRequest(messages=[{"role": "user", "content": "hi"}], tools=[_tool_spec()]))
        assert anthropic_chat.message.content == "anthropic-chat"
        assert anthropic_chat.tool_calls and anthropic_chat.tool_calls[0].name == "add"
        assert await _collect_stream(anthropic.stream(CompletionRequest(prompt="hi"))) == ["anthropic-stream"]

        assert (await ollama.complete(CompletionRequest(prompt="hi"))).content == "ollama-chat"
        assert await _collect_stream(ollama.stream(CompletionRequest(prompt="hi"))) == ["ollama-stream"]

        assert (await google.chat(ChatRequest(messages=[{"role": "user", "content": "hi"}]))).message.content == "google-chat"
        assert await _collect_stream(google.stream(CompletionRequest(prompt="hi"))) == ["google-chat"]

        mistral_chat = await mistral.chat(ChatRequest(messages=[{"role": "user", "content": "hi"}], tools=[_tool_spec()]))
        assert mistral_chat.message.content == "mistral-chat"
        assert mistral_chat.tool_calls and mistral_chat.tool_calls[0].name == "add"
        assert await _collect_stream(mistral.stream(CompletionRequest(prompt="hi"))) == ["mistral-chat"]

        routes = create_routes(LangFn(model=MockChatModel(responses=["ok"])))
        health = next(route for route in routes if route.path == "/health")
        response = await health.handler(
            FakeRequest(method="GET", path="/health"),
            LangFnRouteContext(params={}, query={}, headers={}, url="http://localhost/health", method="GET"),
        )
        assert response.body["ok"] is True
        assert response.body["data"]["name"] == "langfn"
        assert response.body["data"]["version"] == "0.1.0"

        tracer = Tracer(redaction_keys=["api_key"])
        assert tracer.sanitize({"api_key": "secret", "keep": 1}) == {"api_key": "***REDACTED***", "keep": 1}

        class EmptyArgs(BaseModel):
            pass

        async def execute(_args: EmptyArgs, _context) -> str:
            return "pong"

        server = MCPServer(
            [
                Tool(
                    name="ping",
                    description="Ping",
                    args_schema=EmptyArgs,
                    execute=execute,
                )
            ]
        )
        listed = await server.handle({"jsonrpc": "2.0", "id": "1", "method": "tools/list"})
        assert listed.result["tools"][0]["name"] == "ping"

    asyncio.run(run())


class FakeRequest:
    def __init__(self, *, method: str, path: str, body: dict | None = None, headers: dict[str, str] | None = None):
        self._method = method
        self._path = path
        self._body = body or {}
        self._headers = headers or {}

    @property
    def method(self) -> str:
        return self._method

    @property
    def path(self) -> str:
        return self._path

    @property
    def headers(self) -> dict[str, str]:
        return self._headers

    @property
    def query_params(self) -> dict[str, str]:
        return {}

    async def json(self):
        return self._body

    async def body(self) -> bytes:
        return json.dumps(self._body).encode("utf-8")

    async def text(self) -> str:
        return json.dumps(self._body)


def _tool_spec() -> ToolSpec:
    return ToolSpec(
        name="add",
        description="Add numbers",
        input_schema={
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        },
    )


async def _collect_stream(stream) -> list[str]:
    chunks: list[str] = []
    async for event in stream:
        if event.type == "content":
            chunks.append(event.delta)
    return chunks


def _json_response(payload: dict, status_code: int = 200) -> httpx.Response:
    return httpx.Response(status_code, json=payload)


def _openai_handler(request: httpx.Request) -> httpx.Response:
    body = request.content.decode()
    if '"stream":true' in body or '"stream": true' in body:
        return httpx.Response(
            200,
            text='data: {"choices":[{"delta":{"content":"openai-stream"}}]}\n\ndata: [DONE]\n\n',
            headers={"content-type": "text/event-stream"},
        )
    return _json_response(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "openai-chat",
                        "tool_calls": [
                            {"id": "call_1", "function": {"name": "add", "arguments": "{\"a\":2,\"b\":3}"}}
                        ],
                    }
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
    )


def _anthropic_handler(request: httpx.Request) -> httpx.Response:
    body = request.content.decode()
    if '"stream": true' in body or '"stream":true' in body:
        return httpx.Response(
            200,
            text='data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic-stream"}}\n\ndata: {"type":"message_stop"}\n\n',
            headers={"content-type": "text/event-stream"},
        )
    return _json_response(
        {
            "content": [
                {"type": "text", "text": "anthropic-chat"},
                {"type": "tool_use", "id": "call_1", "name": "add", "input": {"a": 2, "b": 3}},
            ],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
    )


def _ollama_handler(request: httpx.Request) -> httpx.Response:
    body = request.content.decode()
    if '"stream":true' in body or '"stream": true' in body:
        return httpx.Response(
            200,
            text='{"done": false, "message": {"content": "ollama-stream"}}\n{"done": true}\n',
            headers={"content-type": "application/x-ndjson"},
        )
    return _json_response({"message": {"role": "assistant", "content": "ollama-chat"}, "prompt_eval_count": 1, "eval_count": 1})


def _google_handler(_request: httpx.Request) -> httpx.Response:
    return _json_response({"candidates": [{"content": {"parts": [{"text": "google-chat"}]}}]})


def _mistral_handler(_request: httpx.Request) -> httpx.Response:
    return _json_response(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "mistral-chat",
                        "tool_calls": [
                            {"id": "call_1", "function": {"name": "add", "arguments": "{\"a\":2,\"b\":3}"}}
                        ],
                    }
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
    )
