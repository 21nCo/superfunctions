from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from .base import Tool, ToolContext


class CodeExecArgs(BaseModel):
    code: str = Field(..., description="Code snippet to execute inside the configured sandbox")


async def execute_code(args: CodeExecArgs, context: ToolContext) -> Any:
    sandbox = context.policy.require_sandbox()
    return sandbox(args.code)


def CodeExecTool() -> Tool[CodeExecArgs, Any]:
    return Tool(
        name="code_exec",
        description="Execute code inside a configured sandbox.",
        args_schema=CodeExecArgs,
        execute=execute_code,
    )
