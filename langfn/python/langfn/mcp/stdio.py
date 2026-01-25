from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Dict, Optional

from ..core.errors import LangFnError
from .types import JSONRPCResponse


@dataclass
class StdioMCPTransport:
    argv: list[str]
    env: Optional[dict[str, str]] = None

    _proc: Optional[asyncio.subprocess.Process] = None
    _next_id: int = 1
    _pending: dict[int, asyncio.Future] = None  # type: ignore[assignment]
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

    async def close(self) -> None:
        if self._proc is None:
            return
        if self._reader_task is not None:
            self._reader_task.cancel()
        self._proc.terminate()
        await self._proc.wait()
        self._proc = None

    async def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        await self.start()
        assert self._proc is not None
        assert self._proc.stdin is not None
        request_id = self._next_id
        self._next_id += 1

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[request_id] = fut

        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()
        return await fut

    async def _reader_loop(self) -> None:
        assert self._proc is not None
        assert self._proc.stdout is not None
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                return
            try:
                data = json.loads(line.decode("utf-8"))
                resp = JSONRPCResponse.model_validate(data)
            except Exception:
                continue

            fut = self._pending.pop(resp.id, None)
            if fut is None or fut.done():
                continue
            if resp.error is not None:
                fut.set_exception(LangFnError(resp.error.message, code="MCP_ERROR", metadata={"error": resp.error.model_dump()}))
            else:
                fut.set_result(resp.result)

