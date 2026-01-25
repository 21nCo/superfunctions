from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from ..client import LangFn
from ..core.errors import ToolExecutionError
from ..core.types import Message
from ..tools.base import Tool


@dataclass
class ToolAgentResult:
    messages: List[Dict[str, Any]]
    output: str


class ToolAgent:
    def __init__(
        self,
        *,
        lang: LangFn,
        tools: Sequence[Tool[Any, Any]],
        max_iterations: int = 5,
    ):
        self._lang = lang
        self._tools = list(tools)
        self._max_iterations = max_iterations
        self._tool_map = {t.name: t for t in self._tools}

    async def run(self, prompt: str, *, system: Optional[str] = None) -> ToolAgentResult:
        messages: List[Dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        for _ in range(self._max_iterations):
            resp = await self._lang.chat(messages, tools=self._tools)
            assistant = resp.message.model_dump()

            if resp.tool_calls:
                assistant["tool_calls"] = [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
                    }
                    for c in resp.tool_calls
                ]
            messages.append(assistant)

            if not resp.tool_calls:
                return ToolAgentResult(messages=messages, output=resp.message.content)

            for call in resp.tool_calls:
                tool = self._tool_map.get(call.name)
                if tool is None:
                    raise ToolExecutionError(f"Unknown tool: {call.name}", metadata={"tool": call.name})
                result = await tool.run(call.arguments)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})

        raise ToolExecutionError("Max iterations exceeded", metadata={"max_iterations": self._max_iterations})

