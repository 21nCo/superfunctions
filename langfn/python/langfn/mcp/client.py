from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .stdio import StdioMCPTransport
from .types import MCPTool


@dataclass
class MCPClient:
    transport: StdioMCPTransport

    async def list_tools(self) -> List[MCPTool]:
        result = await self.transport.request("tools/list", {})
        return [MCPTool.model_validate(t) for t in result or []]

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        return await self.transport.request("tools/call", {"name": name, "arguments": arguments or {}})

