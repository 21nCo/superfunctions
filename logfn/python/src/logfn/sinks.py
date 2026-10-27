"""Console and bounded HTTP sinks."""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
import sys
import threading
import urllib.error
import urllib.request
from collections import deque
from collections.abc import Awaitable, Callable, Iterable
from re import Pattern
from typing import Literal
from urllib.parse import urlsplit

from .redact import REDACTED, make_redactor
from .types import LogEvent

_COLORS = {
    "trace": "\033[90m",  # Gray
    "debug": "\033[34m",  # Blue
    "info": "\033[32m",  # Green
    "warn": "\033[33m",  # Yellow
    "error": "\033[31m",  # Red
    "fatal": "\033[35m",  # Magenta
}


class SinkConsole:
    """Writes events to stdout as JSON lines or pretty text."""

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
        color_code = _COLORS.get(level, "") if self.color else ""
        reset = "\033[0m" if self.color else ""

        ctx_str = ""
        if event.get("ctx"):
            ctx_str = " " + " ".join(f"{key}={value}" for key, value in event["ctx"].items())

        print(f"{color_code}[{event['ts']}] {level.upper()} ({event['name']}): {event['msg']}{reset}{ctx_str}")

    async def flush(self) -> None:
        pass


# Sends one request and returns its HTTP status; raises on network errors.
Transport = Callable[[str, bytes, dict[str, str], float], Awaitable[int]]
DropReason = Literal["queue_full", "delivery_failed", "closed", "redaction_failed"]


async def urllib_transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
    """Default transport: a standard-library POST run in a worker thread."""

    def send() -> int:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - http(s) only
                return int(response.status)
        except urllib.error.HTTPError as error:
            return int(error.code)

    return await asyncio.to_thread(send)


class DeliveryError(Exception):
    """A batch was rejected by the collector."""

    def __init__(self, status: int):
        super().__init__(f"HTTP {status}")
        self.status = status


def _positive_int(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"SinkHttp: {name} must be a positive integer")
    return value


def _non_negative(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not value >= 0:
        raise ValueError(f"SinkHttp: {name} must be a non-negative number")
    return float(value)


def _validate_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("SinkHttp: url must be an absolute http(s) URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("SinkHttp: url must not contain credentials; use auth_token")


def _retryable(status: int) -> bool:
    return status in (408, 429) or status >= 500


class SinkHttp:
    """Bounded, batched HTTP delivery of ``{"events": [...]}``.

    Constructing the sink performs no I/O. Each event is redacted before it is
    queued; the queue keeps at most ``max_queue`` events and drops the oldest.
    Calling the sink never raises and never waits for the network: a full
    batch is sent on the running event loop, a partial one after
    ``flush_interval_ms``. Without a running loop events wait for ``flush()``.
    """

    def __init__(
        self,
        url: str,
        auth_token: str | None = None,
        batch_size: int = 10,
        flush_interval_ms: int = 1000,
        timeout: float = 5.0,
        *,
        headers: dict[str, str] | None = None,
        secret_header: str | None = None,
        max_queue: int = 5000,
        retry_attempts: int = 5,
        backoff_ms: float = 200,
        redact_patterns: Iterable[str | Pattern[str]] | None = None,
        redact_keys: Iterable[str] | None = None,
        redact_allowlist: Iterable[str] | None = None,
        redact_replacement: str = REDACTED,
        transport: Transport | None = None,
        on_error: Callable[[BaseException], None] | None = None,
        on_drop: Callable[[int, DropReason], None] | None = None,
    ):
        _validate_url(url)
        self.url = url
        self.batch_size = _positive_int(batch_size, "batch_size")
        self.max_queue = _positive_int(max_queue, "max_queue")
        self.retry_attempts = _positive_int(retry_attempts, "retry_attempts")
        self.backoff_ms = _non_negative(backoff_ms, "backoff_ms")
        self.flush_interval_ms = _non_negative(flush_interval_ms, "flush_interval_ms")
        self.timeout = _non_negative(timeout, "timeout")
        self._transport: Transport = transport or urllib_transport
        self._on_error = on_error
        self._on_drop = on_drop
        self._redact = make_redactor(redact_patterns, redact_replacement, redact_keys, redact_allowlist)

        self._headers = {"Content-Type": "application/json", **(headers or {})}
        if auth_token:
            if secret_header:
                self._headers[secret_header] = auth_token
            else:
                self._headers["Authorization"] = f"Bearer {auth_token}"

        self._queue: deque[LogEvent] = deque()
        self._lock = threading.Lock()
        self._sent = 0
        self._dropped = 0
        self._failed_batches = 0
        self._in_flight = 0
        self._closed = False
        self._drain_task: asyncio.Task[None] | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._timer_loop: asyncio.AbstractEventLoop | None = None

    # -- reporting -------------------------------------------------------

    def _report(self, error: BaseException) -> None:
        try:
            if self._on_error is not None:
                self._on_error(error)
            else:
                print(f"[logfn http-sink error] {error!r}", file=sys.stderr)
        except Exception:
            pass  # A failing handler must not break delivery.

    def _drop(self, count: int, reason: DropReason) -> None:
        if count <= 0:
            return
        self._dropped += count
        if self._on_drop is not None:
            with contextlib.suppress(Exception):
                self._on_drop(count, reason)

    # -- enqueue ---------------------------------------------------------

    def __call__(self, batch: list[LogEvent]) -> None:
        try:
            if not isinstance(batch, list) or not batch:
                return
            if self._closed:
                self._drop(len(batch), "closed")
                return
            redacted: list[LogEvent] = []
            for event in batch:
                try:
                    redacted.append(self._redact(event))
                except Exception as error:
                    self._drop(1, "redaction_failed")
                    self._report(error)
            with self._lock:
                self._queue.extend(redacted)
                overflow = len(self._queue) - self.max_queue
                for _ in range(max(0, overflow)):
                    self._queue.popleft()
                queued = len(self._queue)
            self._drop(overflow, "queue_full")
            if queued >= self.batch_size:
                self._start_drain()
            elif queued > 0:
                self._schedule_timer()
        except Exception as error:
            self._report(error)

    # -- scheduling ------------------------------------------------------

    @staticmethod
    def _running_loop() -> asyncio.AbstractEventLoop | None:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _active_drain(self, loop: asyncio.AbstractEventLoop) -> asyncio.Task[None] | None:
        task = self._drain_task
        if task is None or task.done() or task.get_loop() is not loop:
            return None
        return task

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _schedule_timer(self) -> None:
        loop = self._running_loop()
        if loop is None or self._active_drain(loop) is not None:
            return
        # A handle left by an earlier, finished loop never fires; replace it.
        if self._timer is not None and not self._timer.cancelled() and self._timer_loop is loop:
            return
        self._timer = loop.call_later(self.flush_interval_ms / 1000, self._on_timer)
        self._timer_loop = loop

    def _on_timer(self) -> None:
        self._timer = None
        self._start_drain()

    def _start_drain(self) -> asyncio.Task[None] | None:
        loop = self._running_loop()
        if loop is None:
            return None
        active = self._active_drain(loop)
        if active is not None:
            return active
        self._cancel_timer()
        task = loop.create_task(self._drain())
        task.add_done_callback(self._after_drain)
        self._drain_task = task
        return task

    def _after_drain(self, task: asyncio.Task[None]) -> None:
        if self._drain_task is task:
            self._drain_task = None
        if task.cancelled():
            return  # The loop is going away; the next flush picks the queue up.
        queued = len(self._queue)
        if queued >= self.batch_size:
            self._start_drain()
        elif queued > 0 and not self._closed:
            self._schedule_timer()

    # -- delivery --------------------------------------------------------

    async def _drain(self) -> None:
        # Sends the events queued when it starts; later events go to the next
        # drain so a flush cannot be held open by a steady stream of events.
        budget = len(self._queue)
        while budget > 0:
            with self._lock:
                count = min(self.batch_size, budget, len(self._queue))
                events = [self._queue.popleft() for _ in range(count)]
            if not events:
                break
            budget -= len(events)
            self._in_flight = len(events)
            try:
                await self._deliver(events)
                self._sent += len(events)
            except asyncio.CancelledError:
                # The loop is shutting down: keep the batch for a later flush.
                with self._lock:
                    self._queue.extendleft(reversed(events))
                raise
            except Exception as error:
                self._failed_batches += 1
                self._drop(len(events), "delivery_failed")
                self._report(error)
            finally:
                self._in_flight = 0

    async def _deliver(self, events: list[LogEvent]) -> None:
        body = json.dumps({"events": events}, separators=(",", ":"), default=str).encode("utf-8", "replace")
        last_error: BaseException = RuntimeError("not sent")
        for attempt in range(self.retry_attempts):
            if attempt > 0:
                # Exponential backoff with jitter
                await asyncio.sleep((self.backoff_ms * 2 ** (attempt - 1) + random.random() * 100) / 1000)
            try:
                status = await asyncio.wait_for(
                    self._transport(self.url, body, dict(self._headers), self.timeout), self.timeout
                )
            except asyncio.TimeoutError:
                last_error = TimeoutError(f"timed out after {self.timeout}s")
                continue
            except Exception as error:
                last_error = error
                continue
            if 200 <= status < 300:
                return
            last_error = DeliveryError(status)
            if not _retryable(status):
                break
        raise last_error

    # -- public ----------------------------------------------------------

    async def flush(self) -> None:
        """Send everything queued so far. Never raises."""
        try:
            self._cancel_timer()
            loop = asyncio.get_running_loop()
            active = self._active_drain(loop)
            if active is not None:
                await asyncio.wait([active])
            if self._queue:
                task = self._start_drain()
                if task is not None:
                    await asyncio.wait([task])
            self._cancel_timer()
        except Exception as error:
            self._report(error)

    async def close(self) -> None:
        """Stop accepting events, then flush. Never raises."""
        self._closed = True
        await self.flush()

    def stats(self) -> dict[str, int]:
        """Delivery counters: queued, in_flight, sent, dropped, failed_batches."""
        return {
            "queued": len(self._queue),
            "in_flight": self._in_flight,
            "sent": self._sent,
            "dropped": self._dropped,
            "failed_batches": self._failed_batches,
        }
