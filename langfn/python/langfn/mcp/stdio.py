from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from ..core.errors import MCPProtocolError, MCPTransportError
from .types import JSONRPCResponse


@dataclass
class StdioMCPTransport:
    argv: list[str]
    env: Optional[dict[str, str]] = None
    close_timeout_s: float = 0.25

    _proc: Optional[asyncio.subprocess.Process] = None
    _next_id: int = 1
    _pending: dict[int, asyncio.Future] = field(default_factory=dict)
    _reader_task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        if self._proc is not None:
            return
        self._pending = {}
        self._proc = await asyncio.create_subprocess_exec(
            *self.argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
        )
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def close(self, timeout_s: Optional[float] = None) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return

        for future in self._pending.values():
            if not future.done():
                future.set_exception(MCPTransportError("MCP transport closed before a response was received"))
        self._pending.clear()

        if self._reader_task is not None:
            self._reader_task.cancel()

        if proc.stdin is not None:
            proc.stdin.close()

        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_s or self.close_timeout_s)
        except asyncio.TimeoutError as exc:
            raise MCPTransportError("MCP process shutdown timed out") from exc
        finally:
            self._reader_task = None

    async def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        await self.start()
        assert self._proc is not None
        assert self._proc.stdin is not None
        request_id = self._next_id
        self._next_id += 1

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[request_id] = future

        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        try:
            self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()
        except Exception as exc:  # noqa: BLE001
            self._pending.pop(request_id, None)
            raise MCPTransportError("Failed to write MCP stdio request") from exc

        return await future

    async def _reader_loop(self) -> None:
        assert self._proc is not None
        assert self._proc.stdout is not None
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(MCPTransportError("MCP transport closed"))
                self._pending.clear()
                return
            try:
                data = json.loads(line.decode("utf-8"))
                response = JSONRPCResponse.model_validate(data)
            except Exception:
                continue

            if isinstance(response.id, str):
                try:
                    request_id = int(response.id)
                except ValueError:
                    continue
            else:
                request_id = response.id

            future = self._pending.pop(request_id, None)
            if future is None or future.done():
                continue
            if response.error is not None:
                future.set_exception(
                    MCPProtocolError(
                        response.error.message,
                        metadata={"error": response.error.model_dump()},
                    )
                )
            else:
                future.set_result(response.result)
