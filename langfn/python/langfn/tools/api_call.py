from __future__ import annotations

import httpx
from pydantic import BaseModel, Field
from .base import Tool, ToolContext


class ApiCallArgs(BaseModel):
    url: str = Field(..., description="The URL to call")
    method: str = Field("GET", description="The HTTP method (GET, POST, etc.)")
    headers: dict = Field(default_factory=dict, description="HTTP headers")
    body: Any = Field(None, description="Request body")


async def execute_api_call(args: ApiCallArgs, context: ToolContext) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            method=args.method,
            url=args.url,
            headers=args.headers,
            json=args.body if args.body else None
        )
        try:
            return resp.json()
        except Exception:
            return resp.text


def ApiCallTool() -> Tool[ApiCallArgs, Any]:
    return Tool(
        name="api_call",
        description="Make an HTTP API call to a remote service.",
        args_schema=ApiCallArgs,
        execute=execute_api_call
    )
