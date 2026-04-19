import os
import sys

import pytest

from langfn.core.errors import MCPProtocolError, MCPTransportError
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

    await client.close()


@pytest.mark.asyncio
async def test_mcp_stdio_unknown_method_is_protocol_error():
    here = os.path.dirname(__file__)
    server_script = os.path.join(here, "mcp_stdio_server.py")

    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([os.path.abspath(os.path.join(here, "..")), env.get("PYTHONPATH", "")])

    transport = StdioMCPTransport([sys.executable, server_script], env=env)
    with pytest.raises(MCPProtocolError) as error:
        await transport.request("tools/unknown", {})
    assert error.value.code == "MCP_PROTOCOL_ERROR"
    await transport.close()


@pytest.mark.asyncio
async def test_mcp_stdio_shutdown_timeout_is_transport_error():
    class HangingProcess:
        stdin = None

        def terminate(self):
            return None

        async def wait(self):
            await asyncio.sleep(1)

    import asyncio

    transport = StdioMCPTransport(["python", "-c", "pass"], close_timeout_s=0.01)
    transport._proc = HangingProcess()  # type: ignore[assignment]
    with pytest.raises(MCPTransportError) as error:
        await transport.close()
    assert error.value.code == "MCP_TRANSPORT_ERROR"
