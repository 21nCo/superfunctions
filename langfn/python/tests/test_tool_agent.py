import json

import httpx
import pytest
from pydantic import BaseModel

from langfn import LangFn
from langfn.core.errors import ToolExecutionError, ToolSchemaError
from langfn.core.types import ChatRequest, ChatResponse, Message, ToolCall
from langfn.models import AnthropicChatModel, OpenAIChatModel
from langfn.models.base import ChatModel
from langfn.tools import Tool, ToolContext


class AddArgs(BaseModel):
    a: int
    b: int


async def add(args: AddArgs, _ctx: ToolContext) -> int:
    return args.a + args.b


class _ToolModel(ChatModel):
    provider = "mock"
    model = "tool-mock"

    def __init__(self):
        self.calls = 0
        self.last_messages = None

    async def complete(self, request):  # pragma: no cover
        raise NotImplementedError()

    async def stream(self, request):  # pragma: no cover
        raise NotImplementedError()

    async def chat(self, request: ChatRequest) -> ChatResponse:
        self.calls += 1
        self.last_messages = request.messages
        if self.calls == 1:
            return ChatResponse(
                message=Message(role="assistant", content=""),
                tool_calls=[ToolCall(id="call_1", name="add", arguments={"a": 2, "b": 3})],
            )

        tool_msg = next(message for message in request.messages if message.get("role") == "tool")
        result = json.loads(tool_msg["content"])
        return ChatResponse(message=Message(role="assistant", content=f"Result is {result}"))


@pytest.mark.asyncio
async def test_tool_agent_runs_tool_and_preserves_tool_call_history():
    tools = [Tool(name="add", description="Add", args_schema=AddArgs, execute=add)]
    model = _ToolModel()
    lang = LangFn(model=model)
    agent = lang.create_tool_agent(tools, max_iterations=3)
    out = await agent.run("what is 2+3?")
    assert out.output == "Result is 5"
    assert any(message["role"] == "tool" and message["tool_call_id"] == "call_1" for message in out.messages)
    assistant = next(message for message in out.messages if message["role"] == "assistant" and message.get("tool_calls"))
    assert assistant["tool_calls"][0]["id"] == "call_1"


@pytest.mark.asyncio
async def test_tool_agent_invalid_tool_args_raise_tool_schema_error():
    class InvalidArgsModel(_ToolModel):
        async def chat(self, request: ChatRequest) -> ChatResponse:
            return ChatResponse(
                message=Message(role="assistant", content=""),
                tool_calls=[ToolCall(id="call_1", name="add", arguments={"a": "bad", "b": 3})],
            )

    agent = LangFn(model=InvalidArgsModel()).create_tool_agent(
        [Tool(name="add", description="Add", args_schema=AddArgs, execute=add)],
        max_iterations=1,
    )
    with pytest.raises(ToolSchemaError) as error:
        await agent.run("bad")
    assert error.value.code == "TOOL_SCHEMA_ERROR"


@pytest.mark.asyncio
async def test_tool_agent_unknown_tool_raises_tool_execution_error():
    class UnknownToolModel(_ToolModel):
        async def chat(self, request: ChatRequest) -> ChatResponse:
            return ChatResponse(
                message=Message(role="assistant", content=""),
                tool_calls=[ToolCall(id="call_1", name="missing", arguments={})],
            )

    agent = LangFn(model=UnknownToolModel()).create_tool_agent([], max_iterations=1)
    with pytest.raises(ToolExecutionError) as error:
        await agent.run("bad")
    assert error.value.code == "TOOL_EXECUTION_ERROR"


@pytest.mark.asyncio
async def test_openai_and_anthropic_receive_provider_native_tool_payloads():
    observed = {"openai": None, "anthropic": None}

    def openai_handler(request: httpx.Request) -> httpx.Response:
        observed["openai"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "done"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    def anthropic_handler(request: httpx.Request) -> httpx.Response:
        observed["anthropic"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "content": [{"type": "text", "text": "done"}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    tools = [Tool(name="add", description="Add", args_schema=AddArgs, execute=add)]
    openai = LangFn(
        model=OpenAIChatModel(api_key="sk-test", transport=httpx.MockTransport(openai_handler))
    )
    anthropic = LangFn(
        model=AnthropicChatModel(api_key="sk-test", transport=httpx.MockTransport(anthropic_handler))
    )

    await openai.chat([{"role": "user", "content": "2+3?"}], tools=tools)
    await anthropic.chat([{"role": "user", "content": "2+3?"}], tools=tools)

    assert observed["openai"]["tools"][0]["function"]["parameters"]["properties"]["a"]["type"] == "integer"
    assert observed["anthropic"]["tools"][0]["input_schema"]["properties"]["a"]["type"] == "integer"
