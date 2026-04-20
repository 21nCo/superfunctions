from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence

from ..client import LangFn
from ..core.errors import AgentMaxIterationsError, ToolExecutionError
from ..tools.base import Tool, ToolContext
from ..tools.policy import ToolPolicy


@dataclass
class ReActResult:
    messages: List[Dict[str, Any]]
    output: str


class ReActAgent:
    def __init__(
        self,
        *,
        model: LangFn,
        tools: Sequence[Tool[Any, Any]],
        max_iterations: int = 10,
        system_prompt: str = "You are a helpful assistant with access to tools. Use them to answer the user's request.",
    ):
        self._model = model
        self._tools = list(tools)
        self._max_iterations = max_iterations
        self._tool_map = {tool.name: tool for tool in self._tools}
        self._system_prompt = system_prompt

    async def run(self, prompt: str) -> ReActResult:
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": prompt},
        ]
        raw_policy = self._model._security if hasattr(self._model, "_security") else None
        policy = raw_policy if isinstance(raw_policy, ToolPolicy) else ToolPolicy(**(raw_policy or {}))

        for _ in range(self._max_iterations):
            response = await self._model.chat(messages, tools=self._tools, tool_choice="auto")
            assistant_message = response.message.model_dump()
            if response.tool_calls:
                assistant_message["tool_calls"] = [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
                    }
                    for call in response.tool_calls
                ]
            messages.append(assistant_message)

            if not response.tool_calls:
                return ReActResult(messages=messages, output=response.message.content)

            for call in response.tool_calls:
                tool = self._tool_map.get(call.name)
                if tool is None:
                    raise ToolExecutionError(f"Unknown tool: {call.name}", metadata={"tool": call.name})
                result = await tool.run(
                    call.arguments,
                    context=ToolContext(metadata={"tool_call_id": call.id}, policy=policy),
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": result if isinstance(result, str) else json.dumps(result),
                    }
                )

        raise AgentMaxIterationsError("Agent exceeded max iterations", metadata={"max_iterations": self._max_iterations})
