import asyncio
import json
import sys
from typing import Optional

import httpx

from .types import LogEvent


class SinkConsole:
    def __init__(self, json: bool = False, color: bool = True):
        self.json = json
        self.color = color

    def __call__(self, batch: list[LogEvent]) -> None:
        for event in batch:
            if self.json:
                print(json.dumps(event, default=str))
            else:
                self._print_pretty(event)

    def _print_pretty(self, event: LogEvent) -> None:
        level = event["level"]
        msg = event["msg"]
        ts = event["ts"]
        name = event["name"]

        # Simple coloring
        color_code = ""
        reset = ""
        if self.color:
            reset = "\033[0m"
            if level == "trace":
                color_code = "\033[90m"  # Gray
            elif level == "debug":
                color_code = "\033[34m"  # Blue
            elif level == "info":
                color_code = "\033[32m"  # Green
            elif level == "warn":
                color_code = "\033[33m"  # Yellow
            elif level == "error":
                color_code = "\033[31m"  # Red
            elif level == "fatal":
                color_code = "\033[35m"  # Magenta

        # Context string
        ctx_str = ""
        if "ctx" in event and event["ctx"]:
            ctx_items = []
            for k, v in event["ctx"].items():
                ctx_items.append(f"{k}={v}")
            ctx_str = " " + " ".join(ctx_items)

        print(f"{color_code}[{ts}] {level.upper()} ({name}): {msg}{reset}{ctx_str}")

    async def flush(self) -> None:
        pass


class SinkHttp:
    """Bounded HTTP batching with explicit failure propagation on flush/close.

    Sync calls enqueue; background delivery runs only in an active event loop.
    Without a loop, call ``await flush()`` later. Failed batches remain queued.
    """

    def __init__(
        self,
        url: str,
        auth_token: Optional[str] = None,
        batch_size: int = 10,
        flush_interval_ms: int = 1000,
        timeout: float = 5.0,
        *,
        attempts: int = 5,
        backoff_ms: float = 200,
        max_queue: int = 5000,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        import math

        for name, value in {
            "batch_size": batch_size,
            "flush_interval_ms": flush_interval_ms,
            "attempts": attempts,
            "max_queue": max_queue,
        }.items():
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        if not math.isfinite(backoff_ms) or backoff_ms < 0:
            raise ValueError("backoff_ms must be finite and nonnegative")
        self.url = url
        self.auth_token = auth_token
        self.batch_size = batch_size
        self.flush_interval_ms = flush_interval_ms
        self.timeout = timeout
        self.attempts = attempts
        self.backoff_ms = backoff_ms
        self.max_queue = max_queue
        self.buffer: list[LogEvent] = []
        self._client = client if client is not None else httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None
        self._lock = asyncio.Lock()
        self._timer: Optional[asyncio.Task[None]] = None
        self._delivery: Optional[asyncio.Task[bool]] = None
        self._closing = False
        self._closed = False

    def __call__(self, batch: list[LogEvent]) -> None:
        if self._closed or self._closing:
            raise RuntimeError("HTTP sink is closed")
        self.buffer.extend(batch)
        if len(self.buffer) > self.max_queue:
            del self.buffer[: -self.max_queue]
        if not self.buffer:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if len(self.buffer) >= self.batch_size:
            if self._delivery is None or self._delivery.done():
                self._delivery = loop.create_task(self._background_flush())
                self._delivery.add_done_callback(self._delivery_finished)
        elif self._timer is None or self._timer.done():
            self._timer = loop.create_task(self._interval_flush())

    def _delivery_finished(self, task: asyncio.Task[bool]) -> None:
        if (not task.cancelled() and task.exception() is None and task.result()
                and self.buffer and not self._closed and not self._closing):
            self([])

    async def _interval_flush(self) -> None:
        try:
            await asyncio.sleep(self.flush_interval_ms / 1000)
            await self._background_flush()
        finally:
            if self._timer is asyncio.current_task():
                self._timer = None

    async def _background_flush(self) -> bool:
        try:
            await self.flush()
            return True
        except Exception as error:
            print(f"[logfn http-sink error] {type(error).__name__}", file=sys.stderr)
            return False

    async def _send(self, batch: list[LogEvent]) -> None:
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        for attempt in range(self.attempts):
            try:
                response = await asyncio.wait_for(
                    self._client.post(
                        self.url, json={"events": batch}, headers=headers, timeout=self.timeout
                    ),
                    timeout=self.timeout,
                )
                response.raise_for_status()
                return
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                if status < 500 and status not in (408, 429):
                    raise
                if attempt + 1 == self.attempts:
                    raise
            except (httpx.TransportError, asyncio.TimeoutError):
                if attempt + 1 == self.attempts:
                    raise
            if attempt + 1 < self.attempts:
                await asyncio.sleep(min(5.0, self.backoff_ms / 1000 * 2 ** min(attempt, 30)))

    async def flush(self) -> None:
        if self._closed:
            return
        if self._timer is not None and self._timer is not asyncio.current_task():
            self._timer.cancel()
            self._timer = None
        async with self._lock:
            while self.buffer:
                batch = self.buffer[: self.batch_size]
                del self.buffer[: self.batch_size]
                try:
                    await self._send(batch)
                except BaseException:
                    self.buffer = (batch + self.buffer)[-self.max_queue :]
                    raise

    async def close(self) -> None:
        if self._closed:
            return
        self._closing = True
        try:
            await self.flush()
            if self._owns_client:
                await self._client.aclose()
        except BaseException:
            self._closing = False
            raise
        self._closed = True
