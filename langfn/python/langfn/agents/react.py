from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from ..client import LangFn
from ..core.errors import ToolExecutionError
from ..core.types import Message
from ..tools.base import Tool


@dataclass
class ReActResult:
    messages: List[Dict[str, Any]]
    output: str


class ReActAgent:
    """
    Implements a ReAct (Reasoning + Acting) agent loop.
    Iteratively:
    1. Thinks about what to do
    2. Decides to call a tool or answer
    3. Observes tool output
    4. Repeats until final answer or max iterations
    """
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
        self._tool_map = {t.name: t for t in self._tools}
        self._system_prompt = system_prompt

    async def run(self, prompt: str) -> ReActResult:
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": prompt}
        ]

        for _ in range(self._max_iterations):
            # Call model with tools
            resp = await self._model.chat(
                messages,
                tools=self._tools,
                tool_choice="auto"
            )
            
            assistant_msg = resp.message.model_dump()
            
            # If there are tool calls, we need to convert them to dict properly for history
            if resp.tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
                    }
                    for c in resp.tool_calls
                ]
            
            messages.append(assistant_msg)

            # If no tool calls, we are done
            if not resp.tool_calls:
                return ReActResult(messages=messages, output=resp.message.content)

            # Execute tools
            for call in resp.tool_calls:
                tool = self._tool_map.get(call.name)
                result_content: str
                if tool is None:
                    result_content = json.dumps({"error": f"Tool {call.name} not found"})
                else:
                    try:
                        # Execute tool
                        raw_result = await tool.run(call.arguments)
                        # Ensure result is stringified for chat history
                        result_content = json.dumps(raw_result) if not isinstance(raw_result, str) else raw_result
                    except Exception as e:
                        result_content = json.dumps({"error": str(e)})

                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": result_content
                })

        # If max iterations reached without final answer
        return ReActResult(
            messages=messages, 
            output="I could not complete the task within the maximum number of steps."
        )
