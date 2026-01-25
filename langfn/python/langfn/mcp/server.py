from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from ..tools.base import Tool, ToolContext


@dataclass(frozen=True)
class MCPServer:
    tools: List[Tool[Any, Any]]

    def _tool_map(self) -> Dict[str, Tool[Any, Any]]:
        return {t.name: t for t in self.tools}

    async def serve_stdio(self) -> None:
        tool_map = self._tool_map()

        async def _write(obj: Dict[str, Any]) -> None:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()

        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                continue

            request_id = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}
            if request_id is None or method is None:
                continue

            try:
                if method == "tools/list":
                    result = [
                        {
                            "name": t.name,
                            "description": t.description,
                            "input_schema": t.json_schema(),
                        }
                        for t in self.tools
                    ]
                    await _write({"jsonrpc": "2.0", "id": request_id, "result": result})
                elif method == "tools/call":
                    name = params.get("name")
                    args = params.get("arguments") or {}
                    tool = tool_map.get(name)
                    if tool is None:
                        raise KeyError(f"Unknown tool: {name}")
                    result = await tool.run(args, context=ToolContext(metadata={"transport": "mcp"}))
                    await _write({"jsonrpc": "2.0", "id": request_id, "result": result})
                else:
                    raise KeyError(f"Unknown method: {method}")
            except Exception as exc:  # noqa: BLE001
                await _write(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32000, "message": str(exc)},
                    }
                )

