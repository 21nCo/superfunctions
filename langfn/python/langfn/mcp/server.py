from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, List

from ..core.errors import MCPProtocolError, ValidationError
from ..tools.base import Tool, ToolContext
from .types import JSONRPCRequest, JSONRPCResponse, MCPTool


@dataclass(frozen=True)
class MCPServer:
    tools: List[Tool[Any, Any]]

    def _tool_map(self) -> Dict[str, Tool[Any, Any]]:
        return {tool.name: tool for tool in self.tools}

    def list_tools(self) -> List[MCPTool]:
        tools = []
        for tool in self.tools:
            definition = tool.json_schema()
            tools.append(
                MCPTool(
                    name=tool.name,
                    description=tool.description,
                    input_schema=definition.get("parameters", {}),
                )
            )
        return sorted(tools, key=lambda tool: tool.name)

    async def handle(self, request: JSONRPCRequest | Dict[str, Any]) -> JSONRPCResponse:
        try:
            parsed = request if isinstance(request, JSONRPCRequest) else JSONRPCRequest.model_validate(request)
            if parsed.method == "tools/list":
                return JSONRPCResponse(id=parsed.id, result={"tools": [tool.model_dump() for tool in self.list_tools()]})
            if parsed.method == "tools/call":
                name = parsed.params.get("name")
                arguments = parsed.params.get("arguments") or {}
                if not isinstance(name, str) or not name:
                    raise ValidationError("MCP tools/call params require a tool name")
                if not isinstance(arguments, dict):
                    raise ValidationError("MCP tools/call arguments must be an object")
                tool = self._tool_map().get(name)
                if tool is None:
                    raise MCPProtocolError(f"Unknown tool: {name}", metadata={"name": name})
                result = await tool.run(arguments, context=ToolContext(metadata={"transport": "mcp"}))
                return JSONRPCResponse(id=parsed.id, result=result)
            raise MCPProtocolError(f"Unknown method: {parsed.method}", metadata={"method": parsed.method})
        except Exception as exc:  # noqa: BLE001
            return JSONRPCResponse(
                id=(request.id if isinstance(request, JSONRPCRequest) else request.get("id", 0)),
                error={
                    "code": -32601 if isinstance(exc, MCPProtocolError) else -32000,
                    "message": str(exc),
                    "data": (
                        {"code": exc.code, "metadata": exc.metadata}
                        if hasattr(exc, "code")
                        else None
                    ),
                },
            )

    async def serve_stdio(self) -> None:
        async def write_message(payload: Dict[str, Any]) -> None:
            sys.stdout.write(json.dumps(payload) + "\n")
            sys.stdout.flush()

        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            response = await self.handle(request)
            await write_message(response.model_dump(exclude_none=True))

    async def handle_sse_request(self, body: Dict[str, Any]) -> tuple[int, Dict[str, str], str]:
        response = await self.handle(body)
        return (
            200,
            {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
            },
            f"data: {json.dumps(response.model_dump(exclude_none=True))}\n\n",
        )
