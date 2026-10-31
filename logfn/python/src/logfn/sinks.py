"""Console and bounded HTTP sinks."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import http.client
import ipaddress
import math
import os
import random
import re
import selectors
import socket
import sys
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable, Iterable
from heapq import merge
from re import Pattern
from typing import Any, Literal
from urllib.parse import urlsplit

from .redact import REDACTED, make_redactor
from .types import LogEvent
from .validation import json_bytes, sanitize_event, validate_and_serialize

# What a synchronous call into caller code (a callback, a sink, a stage) may
# raise as its own failure. A CancelledError raised there is the callee's: a
# real cancellation reaches only an await, never a synchronous call.
_FAILURE = (Exception, asyncio.CancelledError)

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
        for raw in batch:
            # Loggers pass events that are not size-bounded; bound them here.
            event, _truncated = validate_and_serialize(raw)
            if self.json:
                # The encoding the size bound measured: non-ASCII unescaped.
                print(json_bytes(event).decode("utf-8"))
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


# Name resolution cannot be interrupted, so a stalled resolver keeps each
# attempt's thread alive after the attempt is abandoned. Outstanding lookups
# are capped per host, so one host's stalled lookups cannot fail delivery to
# another host, and in the process as a whole. Beyond a cap an attempt fails
# at once with ResolverBusyError (retried like any network error) and starts
# no thread. An IP-literal host needs no lookup and takes no slot.
_RESOLVER_SLOTS_PER_HOST = 4
_RESOLVER_SLOTS = 64


class ResolverBusyError(ConnectionError):
    """Every name-resolution slot for the host, or in the process, is held by
    an outstanding lookup."""


class _ResolverSlots:
    def __init__(self, per_host: int, total: int) -> None:
        self._per_host = per_host
        self._total = total
        self._lock = threading.Lock()
        self._held: dict[str, int] = {}

    def acquire(self, host: str) -> None:
        with self._lock:
            held = self._held.get(host, 0)
            if held >= self._per_host or sum(self._held.values()) >= self._total:
                raise ResolverBusyError(f"too many name resolutions are outstanding for {host!r}")
            self._held[host] = held + 1

    def release(self, host: str) -> None:
        with self._lock:
            held = self._held.get(host, 0) - 1
            if held > 0:
                self._held[host] = held
            else:
                self._held.pop(host, None)


_resolver_slots = _ResolverSlots(_RESOLVER_SLOTS_PER_HOST, _RESOLVER_SLOTS)


def _ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


class _Attempt:
    """The sockets of one request, which abort() stops from any thread: a
    connect in progress fails at once, a later address is never tried, and a
    connected socket is shut down. Connecting also stops at the deadline."""

    def __init__(self, timeout: float, host: str) -> None:
        # Taken before the caller's own timer starts, so it is never later.
        self._deadline = time.monotonic() + timeout
        self._lock = threading.Lock()
        self._sock: socket.socket | None = None
        self._aborted = False
        # abort() writes here to wake a connect waiting in a selector. Made
        # only once the name is resolved, so a stalled lookup holds no fds.
        self._wake_reader: socket.socket | None = None
        self._wake_writer: socket.socket | None = None
        # A resolver slot for the host, held until name resolution returns.
        self._host = host.lower()
        self._slots = _resolver_slots
        self._resolving = not _ip_literal(self._host)
        if self._resolving:
            self._slots.acquire(self._host)

    def _resolved(self) -> None:
        with self._lock:
            if self._resolving:
                self._resolving = False
                self._slots.release(self._host)

    def _attach(self, sock: socket.socket | None) -> None:
        with self._lock:
            if self._sock is not None:
                self._sock.close()
                self._sock = None
            if sock is None:
                return
            if self._aborted:
                raise ConnectionAbortedError("request aborted")
            # A duplicate keeps the connection reachable until release(), so a
            # late abort can never hit a reused descriptor.
            self._sock = sock.dup()

    def connect(self, address: tuple[str, int], timeout: Any = None, source_address: Any = None) -> socket.socket:
        """socket.create_connection, with each address registered before its
        connect starts so that abort() interrupts it. All addresses share the
        attempt's deadline, so none is tried after it."""
        host, port = address
        limit = timeout if isinstance(timeout, (int, float)) else None
        # Name resolution cannot be interrupted; an abort during it stops the
        # loop before any connect.
        try:
            infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        finally:
            self._resolved()
        with self._lock:
            if self._aborted:
                raise ConnectionAbortedError("request aborted")
            self._wake_reader, self._wake_writer = socket.socketpair()
            self._wake_reader.setblocking(False)
            self._wake_writer.setblocking(False)
        first_error: OSError | None = None
        for family, socktype, proto, _name, sockaddr in infos:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out")
            sock = socket.socket(family, socktype, proto)
            try:
                self._attach(sock)
                if source_address:
                    sock.bind(source_address)
                self._connect(sock, sockaddr, remaining)
                with self._lock:
                    # An abort that landed while a connect completed at once.
                    if self._aborted:
                        raise ConnectionAbortedError("request aborted")
                sock.settimeout(limit)
                return sock
            except BaseException as error:
                sock.close()
                self._attach(None)
                if self._aborted or not isinstance(error, OSError):
                    raise
                first_error = first_error or error
        raise first_error or OSError("getaddrinfo returned an empty list")

    def _connect(self, sock: socket.socket, sockaddr: Any, limit: float) -> None:
        sock.setblocking(False)
        try:
            sock.connect(sockaddr)
            return
        except BlockingIOError:
            pass
        with selectors.DefaultSelector() as selector:
            selector.register(sock, selectors.EVENT_WRITE)
            if self._wake_reader is not None:
                selector.register(self._wake_reader, selectors.EVENT_READ)
            ready = {key.fileobj for key, _ in selector.select(limit)}
        if self._aborted or self._wake_reader in ready:
            raise ConnectionAbortedError("request aborted")
        if sock not in ready:
            raise TimeoutError("timed out")
        code = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
        if code:
            raise OSError(code, os.strerror(code))

    def abort(self) -> None:
        with self._lock:
            if self._aborted:
                return
            self._aborted = True
            if self._wake_writer is not None:
                with contextlib.suppress(OSError):
                    self._wake_writer.send(b"\0")
            if self._sock is not None:
                with contextlib.suppress(OSError):
                    self._sock.shutdown(socket.SHUT_RDWR)

    def release(self) -> None:
        with self._lock:
            self._aborted = True
            if self._sock is not None:
                self._sock.close()
                self._sock = None
            if self._wake_reader is not None and self._wake_writer is not None:
                self._wake_reader.close()
                self._wake_writer.close()
        self._resolved()  # The request ended before or without resolving.


def _post(url: str, body: bytes, headers: dict[str, str], timeout: float, attempt: _Attempt) -> int:
    connection: http.client.HTTPConnection | None = None
    try:
        parts = urlsplit(url)
        https = parts.scheme == "https"
        connection_class = http.client.HTTPSConnection if https else http.client.HTTPConnection
        connection = connection_class(parts.hostname or "", (443 if https else 80) if parts.port is None else parts.port, timeout=timeout)
        # HTTPS wraps the connected socket in TLS, which abort() also stops.
        connection._create_connection = attempt.connect  # type: ignore[attr-defined]
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        connection.request("POST", target, body=body, headers=headers)
        # Only the status is used; the body is never read.
        return int(connection.getresponse().status)
    finally:
        if connection is not None:
            connection.close()
        attempt.release()


async def stdlib_transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
    """Default transport: a standard-library (http.client) POST on its own
    connection in a daemon thread. Redirects are not followed; their status is
    returned. The whole request is bounded by ``timeout``: on timeout or
    cancellation a connect in progress is stopped, no further address is
    tried and a connected socket is shut down, so no connection outlives the
    attempt and interpreter or loop shutdown never waits for the collector.
    Only name resolution cannot be interrupted; it ends in its own thread
    and no connect follows it. It holds no sockets, and at most
    ``_RESOLVER_SLOTS_PER_HOST`` (4) lookups per host and ``_RESOLVER_SLOTS``
    (64) in the process are outstanding: beyond that an attempt fails at once
    with ``ResolverBusyError`` and starts no thread, so a hung resolver cannot
    accumulate threads and a stalled host does not hold up other hosts. An
    IP-literal host takes no slot.
    Proxy environment variables are not used."""
    loop = asyncio.get_running_loop()
    result: asyncio.Future[int] = loop.create_future()
    attempt = _Attempt(timeout, urlsplit(url).hostname or "")

    def settle(status: int | None, error: BaseException | None) -> None:
        if result.done():
            return
        if error is not None:
            result.set_exception(error)
        else:
            result.set_result(status or 0)

    def run() -> None:
        try:
            status, error = _post(url, body, headers, timeout, attempt), None
        except Exception as caught:
            status, error = None, caught
        with contextlib.suppress(RuntimeError):  # The loop is already closed.
            loop.call_soon_threadsafe(settle, status, error)

    try:
        threading.Thread(target=run, name="logfn-http", daemon=True).start()
    except BaseException:
        attempt.release()
        raise
    try:
        return await asyncio.wait_for(result, timeout)
    finally:
        attempt.abort()  # A no-op once the request has finished.


class DeliveryError(Exception):
    """A batch was rejected by the collector."""

    def __init__(self, status: int):
        detail = ": redirects are not followed" if 300 <= status < 400 else ""
        super().__init__(f"HTTP {status}{detail}")
        self.status = status


def _positive_int(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"SinkHttp: {name} must be a positive integer")
    return value


def _finite(value: float) -> bool:
    # Infinite limits would make a batch's retry budget, and so flush() and
    # close(), unbounded.
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _non_negative(value: float, name: str) -> float:
    if not _finite(value) or not value >= 0:
        raise ValueError(f"SinkHttp: {name} must be a finite non-negative number")
    return float(value)


def _positive(value: float, name: str) -> float:
    if not _finite(value) or not value > 0:
        raise ValueError(f"SinkHttp: {name} must be a finite positive number")
    return float(value)


def _validate_url(url: str) -> None:
    parts = urlsplit(url)
    try:
        port_ok = parts.port is None or parts.port > 0
    except ValueError:  # Not a number from 0 to 65535; 0 is no port either.
        port_ok = False
    if parts.scheme not in ("http", "https") or not parts.hostname or not port_ok:
        raise ValueError("SinkHttp: url must be an absolute http(s) URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("SinkHttp: url must not contain credentials; use auth_token")


_HEADER_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


def _header_value(name: object, value: object) -> str:
    # Values are trimmed of HTTP whitespace as fetch does. What is still not
    # sendable fails here, and the error never carries the value, which may
    # be a credential.
    if not isinstance(name, str) or not _HEADER_NAME.fullmatch(name):
        raise ValueError("SinkHttp: header names must be HTTP tokens")
    text = value.strip(" \t\r\n") if isinstance(value, str) else None
    if text is None or any(char in "\r\n\0" or char > "\xff" for char in text):
        raise ValueError(f"SinkHttp: header {name} must be a Latin-1 string without CR, LF or NUL")
    return text


def _retryable(status: int) -> bool:
    return status in (408, 429) or status >= 500


class SinkHttp:
    """Bounded, batched HTTP delivery of ``{"events": [...]}``.

    Constructing the sink performs no I/O. Each event is made JSON-safe,
    redacted (every field, keys included) and size-bounded before it is
    queued, so what is sent is exactly what was redacted; this cannot be
    disabled. The queue keeps at most ``max_queue`` events and drops the
    oldest. Redirects are not followed: a 3xx fails the batch without retry.
    Calling the sink never raises and never waits for the network: a full
    batch is sent on the running event loop, a partial one after
    ``flush_interval_ms``. Without a running loop events wait for ``flush()``.
    The sink may be called from any thread and flushed or closed on any loop;
    ``flush()`` and ``close()`` also wait for batches other loops are sending.
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
        # A zero timeout would fail every attempt and drop every batch.
        self.timeout = _positive(timeout, "timeout")
        self._transport: Transport = transport or stdlib_transport
        self._on_error = on_error
        self._on_drop = on_drop
        self._reporting = threading.local()
        self._redact = make_redactor(redact_patterns, redact_replacement, redact_keys, redact_allowlist)

        # Sources apply in order, never pre-merged; each name drops every
        # earlier spelling (names are case-insensitive).
        self._headers: dict[str, str] = {}
        credential = (
            {secret_header or "Authorization": auth_token if secret_header else f"Bearer {auth_token}"} if auth_token else {}
        )
        for source in ({"Content-Type": "application/json"}, headers or {}, credential):
            for name, value in source.items():
                text = _header_value(name, value)
                for key in [key for key in self._headers if key.lower() == name.lower()]:
                    del self._headers[key]
                self._headers[name] = text
        # Set in each transport call's own task: what the transport logs to
        # this sink is its own diagnostics (see _report).
        self._in_transport: contextvars.ContextVar[bool] = contextvars.ContextVar("logfn_in_transport", default=False)

        # Queued events carry their position in the stream of accepted events,
        # in ascending order, so flush() can tell which were accepted before
        # it, and whether a reporting callback logged them (see _report).
        self._queue: deque[_Item] = deque()
        self._lock = threading.Lock()
        self._accepted = 0
        self._sent = 0
        self._dropped = 0
        self._failed_batches = 0
        # Every batch being delivered, on any event loop. A batch is settled
        # (sent, dropped or put back) exactly once, by whoever comes first.
        self._batches: list[_Batch] = []
        # Loops waiting in flush() for a settlement; woken on every one.
        self._waiters: list[tuple[asyncio.AbstractEventLoop, asyncio.Future[None]]] = []
        # Longest a batch can take: every attempt (with its cancel grace) and
        # backoff, plus slack.
        self._batch_budget = (
            self.retry_attempts * (self.timeout + _CANCEL_GRACE)
            + sum(self.backoff_ms * 2 ** (attempt - 1) + 100 for attempt in range(1, self.retry_attempts)) / 1000
            + 1.0
        )
        if not math.isfinite(self._batch_budget):
            raise ValueError("SinkHttp: timeout, backoff_ms and retry_attempts make an unbounded retry budget")
        self._closed = False
        self._drains: dict[asyncio.AbstractEventLoop, asyncio.Task[None]] = {}
        self._timer: asyncio.TimerHandle | None = None
        self._timer_loop: asyncio.AbstractEventLoop | None = None

    # -- reporting -------------------------------------------------------

    # on_error and on_drop may log to this sink, which can fail or drop again
    # (a closed sink, a full queue). Such a nested error or drop is counted
    # but not reported to the callback that is running on this thread, so a
    # callback is never re-entered and one event cannot start a recursion.
    #
    # Events accepted while either callback runs on the calling thread, or
    # while the transport runs, are their diagnostics. A batch made only of
    # them that later fails or is dropped is counted, and its error goes to
    # stderr, but neither callback is called for it: otherwise a collector
    # that always fails would turn one event into an endless chain of
    # requests and callbacks. Sending what the transport logged makes it log
    # again, so a queue made only of those events waits for the interval
    # timer instead of draining at once.

    def _in_callback(self) -> bool:
        return bool(getattr(self._reporting, "error", False) or getattr(self._reporting, "drop", False))

    def _report(self, error: BaseException, from_feedback: bool = False) -> None:
        if from_feedback:
            with contextlib.suppress(*_FAILURE):
                print(f"[logfn http-sink error] {error!r}", file=sys.stderr)
            return
        if getattr(self._reporting, "error", False):
            return
        self._reporting.error = True
        try:
            if self._on_error is not None:
                self._on_error(error)
            else:
                print(f"[logfn http-sink error] {error!r}", file=sys.stderr)
        except _FAILURE:
            pass  # A failing handler must not break delivery.
        finally:
            self._reporting.error = False

    def _notify_drop(self, count: int, reason: DropReason, from_feedback: bool = False) -> None:
        if count <= 0 or from_feedback or self._on_drop is None or getattr(self._reporting, "drop", False):
            return
        self._reporting.drop = True
        try:
            self._on_drop(count, reason)
        except _FAILURE:
            pass
        finally:
            self._reporting.drop = False

    def _drop(self, count: int, reason: DropReason) -> None:
        if count <= 0:
            return
        with self._lock:
            self._dropped += count
        self._notify_drop(count, reason)

    # -- enqueue ---------------------------------------------------------

    def _prepare(self, event: LogEvent) -> LogEvent:
        # JSON-safe values first, so serialization cannot add text (__str__,
        # bytes), then redaction, then the size bound.
        final, _truncated = validate_and_serialize(self._redact(sanitize_event(event)))
        return final

    def __call__(self, batch: list[LogEvent]) -> None:
        try:
            if not isinstance(batch, list) or not batch:
                return
            if self._closed:
                self._drop(len(batch), "closed")
                return
            # Only the newest max_queue events of a batch could stay queued, so
            # the older ones are dropped without being prepared (copied).
            excess = len(batch) - self.max_queue
            if excess > 0:
                self._drop(excess, "queue_full")
                batch = batch[excess:]
            from_feedback = _TRANSPORT if self._in_transport.get() else _CALLBACK if self._in_callback() else _CALLER
            redacted: list[LogEvent] = []
            for event in batch:
                try:
                    redacted.append(self._prepare(event))
                except _FAILURE as error:
                    self._drop(1, "redaction_failed")
                    self._report(error)
            with self._lock:
                # Checked again under the lock close() sets it with: a batch
                # still being prepared when close() started is dropped here,
                # never queued behind close()'s final flush.
                late = self._closed
                if not late:
                    for event in redacted:
                        self._queue.append((self._accepted, event, from_feedback))
                        self._accepted += 1
                overflow, overflow_feedback = self._trim()
                queued = len(self._queue)
            if late:
                self._drop(len(redacted), "closed")
                return
            self._notify_drop(overflow, "queue_full", overflow_feedback)
            if queued >= self.batch_size:
                self._start_drain()
            elif queued > 0:
                self._schedule_timer()
        except _FAILURE as error:
            self._report(error)

    def _trim(self) -> tuple[int, bool]:
        # Under the lock: drops the oldest events beyond max_queue and counts
        # them; the caller reports them once the lock is released. Also
        # returns whether all of them were callback diagnostics.
        overflow = max(0, len(self._queue) - self.max_queue)
        trimmed = [self._queue.popleft() for _ in range(overflow)]
        self._dropped += overflow
        return overflow, _only_feedback(trimmed)

    # -- scheduling ------------------------------------------------------

    @staticmethod
    def _running_loop() -> asyncio.AbstractEventLoop | None:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _active_drain(self, loop: asyncio.AbstractEventLoop) -> asyncio.Task[None] | None:
        task = self._drains.get(loop)
        return task if task is not None and not task.done() else None

    def _cancel_timer(self, loop: asyncio.AbstractEventLoop) -> None:
        # Timer handles belong to their loop; another loop's timer is left to
        # fire, which at worst starts a drain with nothing to send.
        if self._timer is not None and self._timer_loop is loop:
            self._timer.cancel()
            self._timer = None

    def _schedule_timer(self) -> None:
        loop = self._running_loop()
        if loop is None or self._active_drain(loop) is not None:
            return
        # A handle left by another or finished loop may never fire; replace it.
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
        self._cancel_timer(loop)
        # create_task does not run the drain yet, so it is registered before
        # any caller code (transport, on_drop, on_error) can log to this sink
        # or call flush()/close(); those then join it instead of starting
        # another drain on this loop.
        task = loop.create_task(self._drain())
        task.add_done_callback(self._after_drain)
        # Only this loop's thread reads or writes its own entry.
        self._drains[loop] = task
        return task

    def _after_drain(self, task: asyncio.Task[None]) -> None:
        loop = task.get_loop()
        if self._drains.get(loop) is task:
            del self._drains[loop]
        if task.cancelled():
            return  # The loop is going away; the next flush picks the queue up.
        with self._lock:
            queued = len(self._queue)
            transport_only = all(source == _TRANSPORT for _, _, source in self._queue)
        if queued >= self.batch_size and not transport_only:
            self._start_drain()
        elif queued > 0 and not self._closed:
            self._schedule_timer()

    # -- delivery --------------------------------------------------------

    def _settle(self, batch: _Batch, outcome: Literal["sent", "requeue"] | DropReason) -> bool:
        """Records the batch's outcome unless another path already did, then
        wakes every flush() waiting on any loop. Returns whether it settled."""
        dropped = 0
        reason: DropReason = "queue_full"
        from_feedback = _only_feedback(batch.items)
        with self._lock:
            if batch not in self._batches:
                return False
            self._batches.remove(batch)
            # Decided under the lock close() sets _closed with: once closed, a batch put back is never sent.
            outcome = "closed" if outcome == "requeue" and self._closed else outcome
            if outcome == "sent":
                self._sent += len(batch.items)
            elif outcome == "requeue":
                # Put back in position order; the oldest are trimmed first.
                self._queue = deque(merge(batch.items, self._queue, key=lambda item: item[0]))
                dropped, from_feedback = self._trim()
            else:
                if outcome == "delivery_failed":
                    self._failed_batches += 1
                dropped, reason = len(batch.items), outcome
                self._dropped += dropped
            waiters, self._waiters = self._waiters, []
        self._notify_drop(dropped, reason, from_feedback)
        for loop, waiter in waiters:
            with contextlib.suppress(RuntimeError):  # That loop is closed.
                loop.call_soon_threadsafe(_wake, waiter)
        return True

    async def _drain(self) -> None:
        # Sends the events queued when it starts; later events go to the next
        # drain so a flush cannot be held open by a steady stream of events.
        budget = len(self._queue)
        while budget > 0:
            with self._lock:
                count = min(self.batch_size, budget, len(self._queue))
                if count == 0:
                    break
                batch = _Batch([self._queue.popleft() for _ in range(count)], time.monotonic() + self._batch_budget)
                self._batches.append(batch)
            budget -= count
            # Delivery runs as its own task so that a flush() or close() on
            # another loop that settles the batch can abort the attempt.
            loop = asyncio.get_running_loop()
            delivery = loop.create_task(self._deliver(batch))
            batch.abort = functools.partial(loop.call_soon_threadsafe, delivery.cancel)
            try:
                await asyncio.wait([delivery])
            except asyncio.CancelledError:
                # A delivery that already finished keeps its real outcome;
                # cancelling the drain must not send that batch again.
                if delivery.done() and not delivery.cancelled():
                    self._record(batch, delivery)
                else:
                    delivery.cancel()
                    self._unfinished(batch)
                raise
            self._record(batch, delivery)

    def _unfinished(self, batch: _Batch) -> None:
        # The loop is shutting down: keep the batch for a later flush, unless
        # the sink is closed and nothing will send it again. A no-op when the
        # batch was settled elsewhere (which is what cancels a delivery).
        self._settle(batch, "requeue")

    def _record(self, batch: _Batch, delivery: asyncio.Task[None]) -> None:
        """Settles a batch from its finished delivery."""
        if delivery.cancelled():
            self._unfinished(batch)
            return
        error = delivery.exception()
        if isinstance(error, _Abandoned):
            return  # Settled elsewhere; it has its one outcome.
        if error is None:
            self._settle(batch, "sent")
        elif self._settle(batch, "delivery_failed"):
            self._report(error, _only_feedback(batch.items))

    def _registered(self, batch: _Batch) -> bool:
        with self._lock:
            return batch in self._batches

    async def _deliver(self, batch: _Batch) -> None:
        body = json_bytes({"events": [event for _, event, _ in batch.items]})
        last_error: BaseException = RuntimeError("not sent")
        for attempt in range(self.retry_attempts):
            if attempt > 0:
                if not self._registered(batch):
                    raise _Abandoned
                # Exponential backoff with jitter
                await asyncio.sleep((self.backoff_ms * 2 ** (attempt - 1) + random.random() * 100) / 1000)  # NOSONAR S2245: jitter
            # A batch settled elsewhere (dropped by flush() or close() on
            # another loop) has its one outcome: no further attempt is made.
            if not self._registered(batch):
                raise _Abandoned
            try:
                status = await self._attempt(body)
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

    async def _call(self, body: bytes) -> int:
        self._in_transport.set(True)  # This task's own context only.
        return await self._transport(self.url, body, dict(self._headers), self.timeout)

    async def _attempt(self, body: bytes) -> int:
        """One transport call, bounded by the timeout. It runs as its own task,
        so a CancelledError the transport raises (its own request was
        cancelled) is a failed attempt, not a cancellation of the delivery:
        only the sink or the loop cancels a delivery, which puts its batch
        back. Treating it as one would put the batch back with a fresh budget
        and retry it at once, without end. A call that times out is cancelled
        and given _CANCEL_GRACE to stop; one that ignores the cancellation is
        abandoned (its late result is discarded), so the attempt still ends."""
        call = asyncio.get_running_loop().create_task(self._call(body))
        try:
            done, _ = await asyncio.wait([call], timeout=self.timeout)
            if not done:
                call.cancel()
                await asyncio.wait([call], timeout=_CANCEL_GRACE)
        except asyncio.CancelledError:
            call.cancel()
            call.add_done_callback(_retrieve)
            raise
        if not done:
            call.add_done_callback(_retrieve)
            raise asyncio.TimeoutError
        if call.cancelled():
            raise ConnectionAbortedError("the transport was cancelled")
        return call.result()

    # -- public ----------------------------------------------------------

    async def flush(self) -> None:
        """Wait until every event accepted before the call is sent or dropped,
        across as many drains as that takes, including batches that another
        event loop or thread is delivering. Never raises. A batch that is not
        settled within its retry budget (its loop stopped), also one this
        call's own drain is sending, is dropped as "delivery_failed", or
        "closed" once closed. Events logged while this
        waits are not part of it; they keep their interval timer."""
        try:
            loop = asyncio.get_running_loop()
            self._cancel_timer(loop)
            with self._lock:
                target = self._accepted
            while True:
                with self._lock:
                    queued = bool(self._queue) and self._queue[0][0] < target
                drain = self._start_drain() if queued else None
                if drain is not None:
                    # One step lets a new drain take its first batch, so the
                    # wait below is bounded by that batch's deadline too.
                    await asyncio.sleep(0)
                waiter: asyncio.Future[None] | None = None
                # Queue and batches are read in one snapshot: another loop
                # puts an interrupted batch back under the same lock, so the
                # events in question are seen in one place or the other,
                # never in neither.
                with self._lock:
                    queued = bool(self._queue) and self._queue[0][0] < target
                    pending = [batch for batch in self._batches if batch.items[0][0] < target]
                    if pending:
                        waiter = loop.create_future()
                        self._waiters.append((loop, waiter))
                if waiter is None:
                    if not queued:
                        return
                    continue  # A drain is between batches, or a batch was put back.
                # Woken by any settlement or the end of this loop's drain, and
                # never later than the earliest deadline of a pending batch,
                # however the transport behaves.
                try:
                    await asyncio.wait(
                        [waiter] if drain is None else [waiter, drain],
                        timeout=max(0.0, min(b.deadline for b in pending) - time.monotonic()),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    with self._lock:
                        if (loop, waiter) in self._waiters:
                            self._waiters.remove((loop, waiter))
                now = time.monotonic()
                for batch in pending:
                    if batch.deadline <= now and self._settle(batch, "closed" if self._closed else "delivery_failed"):
                        batch.cancel()
                        self._report(
                            TimeoutError(f"batch not settled within {self._batch_budget:.1f}s"),
                            _only_feedback(batch.items),
                        )
        except Exception as error:
            self._report(error)

    async def close(self) -> None:
        """Stop accepting events, then deliver or drop everything accepted,
        also batches in flight on other loops. Never raises; events that
        cannot be sent are dropped as "closed", also when this is cancelled."""
        with self._lock:
            self._closed = True
        try:
            await self.flush()
        finally:
            with self._lock:
                left = list(self._queue)
                self._queue.clear()
                self._dropped += len(left)
                batches = list(self._batches)
            self._notify_drop(len(left), "closed", _only_feedback(left))
            # A cancelled close() still ends the batches in flight on any loop.
            for batch in batches:
                if self._settle(batch, "closed"):
                    batch.cancel()

    def stats(self) -> dict[str, int]:
        """Delivery counters: queued, in_flight, sent, dropped, failed_batches."""
        with self._lock:
            return {
                "queued": len(self._queue),
                "in_flight": sum(len(batch.items) for batch in self._batches),
                "sent": self._sent,
                "dropped": self._dropped,
                "failed_batches": self._failed_batches,
            }


# Who logged a queued event: the caller, on_error or on_drop, or the transport.
_CALLER, _CALLBACK, _TRANSPORT = 0, 1, 2

# A queued event: its position in the stream of accepted events, the event,
# and who logged it (any but _CALLER is feedback).
_Item = tuple[int, LogEvent, int]


def _only_feedback(items: Iterable[_Item]) -> bool:
    found = False
    for _, _, from_feedback in items:
        if not from_feedback:
            return False
        found = True
    return found


# How long a timed-out transport call may take to stop once cancelled before
# the attempt abandons it.
_CANCEL_GRACE = 0.1


class _Abandoned(Exception):
    """The batch was settled elsewhere; its delivery stops without an outcome."""


class _Batch:
    __slots__ = ("abort", "deadline", "items")

    def __init__(self, items: list[_Item], deadline: float):
        self.items = items
        self.deadline = deadline
        # Cancels the delivery on its own loop; set once delivery starts.
        self.abort: Callable[[], object] | None = None

    def cancel(self) -> None:
        if self.abort is not None:
            with contextlib.suppress(RuntimeError):  # Its loop is closed.
                self.abort()


def _retrieve(task: asyncio.Task[Any]) -> None:
    # An abandoned call's failure has no outcome to change; it is not logged.
    if not task.cancelled():
        task.exception()


def _wake(waiter: asyncio.Future[None]) -> None:
    if not waiter.done():
        waiter.set_result(None)
