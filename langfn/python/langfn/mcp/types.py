from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class MCPTool(BaseModel):
    name: str
    description: str
    input_schema: Dict[str, Any] = Field(default_factory=dict)


class JSONRPCError(BaseModel):
    code: int
    message: str
    data: Optional[Any] = None


class JSONRPCResponse(BaseModel):
    jsonrpc: str = "2.0"
    id: int
    result: Optional[Any] = None
    error: Optional[JSONRPCError] = None

