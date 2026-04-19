import os
import sys

import httpx
import pytest

from langfn.core.errors import MCPProtocolError, MCPTransportError
from langfn.mcp import MCPClient, SSEMCPTransport
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

        def __init__(self):
            self.killed = False

        def terminate(self):
            return None

        def kill(self):
            self.killed = True

        async def wait(self):
            if self.killed:
                return 0
            await asyncio.sleep(1)

    import asyncio

    transport = StdioMCPTransport(["python", "-c", "pass"], close_timeout_s=0.01)
    proc = HangingProcess()
    transport._proc = proc  # type: ignore[assignment]
    with pytest.raises(MCPTransportError) as error:
        await transport.close()
    assert error.value.code == "MCP_TRANSPORT_ERROR"
    assert proc.killed is True


@pytest.mark.asyncio
async def test_mcp_stdio_close_honors_explicit_zero_timeout():
    class SlowExitProcess:
        stdin = None

        def __init__(self):
            self.killed = False

        def terminate(self):
            return None

        def kill(self):
            self.killed = True

        async def wait(self):
            if self.killed:
                return 0
            await asyncio.sleep(0)
            return 0

    import asyncio

    transport = StdioMCPTransport(["python", "-c", "pass"], close_timeout_s=0.5)
    proc = SlowExitProcess()
    transport._proc = proc  # type: ignore[assignment]
    with pytest.raises(MCPTransportError) as error:
        await transport.close(timeout_s=0)
    assert error.value.code == "MCP_TRANSPORT_ERROR"
    assert proc.killed is True
    assert transport._proc is None


@pytest.mark.asyncio
async def test_sse_transport_wraps_httpx_failures():
    class RaisingClient:
        async def post(self, *args, **kwargs):
            raise httpx.ConnectError("boom")

        async def aclose(self):
            return None

    transport = SSEMCPTransport(url="http://localhost/mcp", client=RaisingClient())  # type: ignore[arg-type]
    with pytest.raises(MCPTransportError) as error:
        await transport.request("tools/list", {})
    assert error.value.code == "MCP_TRANSPORT_ERROR"
