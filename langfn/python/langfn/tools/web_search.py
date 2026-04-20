from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from .base import Tool, ToolContext


class WebSearchArgs(BaseModel):
    query: str = Field(..., description="Search query")


async def execute_web_search(args: WebSearchArgs, context: ToolContext) -> Any:
    backend = context.policy.require_search_backend()
    return backend(args.query)


def WebSearchTool() -> Tool[WebSearchArgs, Any]:
    return Tool(
        name="web_search",
        description="Search the web using a configured backend.",
        args_schema=WebSearchArgs,
        execute=execute_web_search,
    )
