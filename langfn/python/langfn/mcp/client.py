from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from ..core.errors import MCPProtocolError, MCPTransportError
from .stdio import StdioMCPTransport
from .types import JSONRPCResponse, ListToolsResult, MCPTool


@dataclass
class SSEMCPTransport:
    url: str
    client: httpx.AsyncClient = field(default_factory=httpx.AsyncClient)
    _next_id: int = 1

    async def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        payload = {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}}
        self._next_id += 1
        response = await self.client.post(
            self.url,
            headers={"accept": "text/event-stream", "content-type": "application/json"},
            json=payload,
        )
        if response.status_code >= 400:
            raise MCPTransportError(
                "SSE transport returned a non-success status",
                metadata={"status": response.status_code},
            )

        line = next((entry for entry in response.text.splitlines() if entry.startswith("data:")), None)
        if line is None:
            raise MCPTransportError("SSE transport returned no data frame")
        try:
            parsed = JSONRPCResponse.model_validate(json.loads(line[5:].strip()))
        except Exception as exc:  # noqa: BLE001
            raise MCPProtocolError("Failed to parse SSE MCP payload") from exc
        if parsed.error is not None:
            raise MCPProtocolError(parsed.error.message, metadata={"error": parsed.error.model_dump()})
        return parsed.result

    async def close(self) -> None:
        await self.client.aclose()


@dataclass
class MCPClient:
    transport: Any

    async def list_tools(self) -> List[MCPTool]:
        result = await self.transport.request("tools/list", {})
        if isinstance(result, list):
            return [MCPTool.model_validate(tool) for tool in result]
        parsed = ListToolsResult.model_validate(result)
        return parsed.tools

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        return await self.transport.request("tools/call", {"name": name, "arguments": arguments or {}})

    async def close(self) -> None:
        await self.transport.close()
