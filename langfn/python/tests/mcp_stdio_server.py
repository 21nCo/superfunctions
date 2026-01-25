import asyncio
import os
import sys

from pydantic import BaseModel


def _ensure_import_path():
    here = os.path.dirname(__file__)
    pkg_root = os.path.abspath(os.path.join(here, ".."))
    if pkg_root not in sys.path:
        sys.path.insert(0, pkg_root)


_ensure_import_path()

from langfn.mcp.server import MCPServer  # noqa: E402
from langfn.tools import Tool, ToolContext  # noqa: E402


class AddArgs(BaseModel):
    a: int
    b: int


async def _add(args: AddArgs, _ctx: ToolContext) -> int:
    return args.a + args.b


async def main() -> None:
    server = MCPServer(
        tools=[
            Tool(
                name="add",
                description="Add two integers",
                args_schema=AddArgs,
                execute=_add,
            )
        ]
    )
    await server.serve_stdio()


if __name__ == "__main__":
    asyncio.run(main())

