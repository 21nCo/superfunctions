import json

import pytest
from pydantic import BaseModel

from langfn import LangFn
from langfn.agents import ToolAgent
from langfn.core.types import ChatRequest, ChatResponse, Message, ToolCall
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

    async def complete(self, request):  # pragma: no cover
        raise NotImplementedError()

    async def stream(self, request):  # pragma: no cover
        raise NotImplementedError()

    async def chat(self, request: ChatRequest) -> ChatResponse:
        self.calls += 1
        if self.calls == 1:
            return ChatResponse(
                message=Message(role="assistant", content=""),
                tool_calls=[ToolCall(id="1", name="add", arguments={"a": 2, "b": 3})],
            )

        tool_msg = next(m for m in request.messages if m.get("role") == "tool")
        result = json.loads(tool_msg["content"])
        return ChatResponse(message=Message(role="assistant", content=f"Result is {result}"))


@pytest.mark.asyncio
async def test_tool_agent_runs_tool_and_returns_final_output():
    tools = [Tool(name="add", description="Add", args_schema=AddArgs, execute=add)]
    lang = LangFn(model=_ToolModel())
    agent = ToolAgent(lang=lang, tools=tools, max_iterations=3)
    out = await agent.run("what is 2+3?")
    assert out.output == "Result is 5"

