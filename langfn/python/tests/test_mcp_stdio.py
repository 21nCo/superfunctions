import os
import sys

import pytest

from langfn.mcp import MCPClient
from langfn.mcp.stdio import StdioMCPTransport


@pytest.mark.asyncio
async def test_mcp_stdio_list_and_call_tools():
    here = os.path.dirname(__file__)
    server_script = os.path.join(here, "mcp_stdio_server.py")

    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([os.path.abspath(os.path.join(here, "..")), env.get("PYTHONPATH", "")])

    transport = StdioMCPTransport([sys.executable, server_script], env=env)
    client = MCPClient(transport=transport)

    tools = await client.list_tools()
    assert [t.name for t in tools] == ["add"]

    result = await client.call_tool("add", {"a": 2, "b": 3})
    assert result == 5

    await transport.close()

