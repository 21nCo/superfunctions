"""Core Logger implementation."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from .sinks import SinkConsole
from .types import (
    DEFAULT_VERSION,
    LOG_LEVEL_VALUES,
    ErrorHandler,
    LogEvent,
    LogLevel,
    PipelineStage,
    Sink,
)
from .validation import sanitize_event

# How often flush() checks that another loop it waits on is still running.
_FOREIGN_POLL_SECONDS = 0.05


def default_now() -> datetime:
    return datetime.now(timezone.utc)


def get_default_level() -> LogLevel:
    env = os.environ.get("ENV", os.environ.get("NODE_ENV", "development"))
    return "info" if env == "production" else "debug"


def _format_ts(moment: datetime) -> str:
    # RFC3339 UTC with milliseconds, matching the TypeScript logger.
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _default_error_handler(error: BaseException, context: dict[str, str]) -> None:
    print(f"[logfn internal error] {context} {error!r}", file=sys.stderr)


def _callable_name(value: Any) -> str:
    return str(getattr(value, "__name__", None) or type(value).__name__ or "unknown")


def _normalize_context(ctx: Any) -> dict[str, Any] | None:
    # A context that is not a dict (an exception passed to logger.error, a
    # string) is kept under a named key instead of being merged.
    if ctx is None:
        return None
    if isinstance(ctx, BaseException):
        return {"error": ctx}
    if not isinstance(ctx, dict):
        return {"value": ctx}
    return ctx


class Logger:
    """Structured logger. Logging calls and ``flush()`` never raise: pipeline
    and sink failures go to ``on_error``."""

    def __init__(
        self,
        name: str,
        sinks: list[Sink] | None = None,
        level: LogLevel | None = None,
        pipeline: list[PipelineStage] | None = None,
        now: Callable[[], datetime] | None = None,
        base_context: dict[str, Any] | None = None,
        base_tags: list[str] | None = None,
        on_error: ErrorHandler | None = None,
    ):
        if level is not None and level not in LOG_LEVEL_VALUES:
            raise ValueError(f"Unknown log level: {level!r}")
        self.name = name
        # The default is local console output only; no remote sink is implied.
        self.sinks: list[Sink] = list(sinks) if sinks is not None else [SinkConsole()]
        self.level: LogLevel = level or get_default_level()
        self.pipeline = list(pipeline or [])
        self.now = now or default_now
        self.base_context = dict(base_context or {})
        self.base_tags = list(base_tags or [])
        self.on_error = on_error or _default_error_handler
        self._pending: set[asyncio.Task[Any]] = set()

        if not self.sinks:
            # We don't throw here to avoid breaking apps, but it's bad practice
            print("Warning: Logger created without sinks", file=sys.stderr)

    def _report(self, error: BaseException, context: dict[str, str]) -> None:
        # A failing error handler must not reach the caller either.
        with contextlib.suppress(Exception):
            self.on_error(error, context)

    def should_log(self, level: LogLevel) -> bool:
        return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[self.level]

    def _log(self, level: LogLevel, msg: Any, ctx: Any, tags: Any, kwargs: dict[str, Any]) -> None:
        try:
            self._emit(level, msg, ctx, tags, kwargs)
        except Exception as error:
            self._report(error, {})

    def _emit(self, level: LogLevel, msg: Any, ctx: Any, tags: Any, kwargs: dict[str, Any]) -> None:
        if not self.should_log(level):
            return

        call_context = _normalize_context(ctx)
        # Merge kwargs into ctx for convenience: logger.info("msg", user_id="1")
        if kwargs:
            call_context = {**(call_context or {}), **kwargs}

        event: LogEvent = {
            "ts": _format_ts(self.now()),
            "level": level,
            "msg": str(msg),
            "name": self.name,
            "version": DEFAULT_VERSION,
        }
        if self.base_context or call_context:
            event["ctx"] = {**self.base_context, **(call_context or {})}
        merged_tags = [*self.base_tags, *(tags if isinstance(tags, (list, tuple)) else [])]
        if merged_tags:
            event["tags"] = merged_tags

        # A failing stage drops the event: a broken redaction stage must not
        # let the unredacted event through.
        current: LogEvent = event
        for stage in self.pipeline:
            try:
                result = stage(current)
            except Exception as error:
                self._report(error, {"stage": _callable_name(stage)})
                return
            if result is None:
                return
            current = result

        # JSON-safe but not size-bounded: truncating here could cut a secret's
        # delimiter (an @, a closing quote) before a sink's own redaction runs,
        # so each sink bounds the size after it redacts.
        final = sanitize_event(current)

        for sink in self.sinks:
            try:
                result = sink([final])
                if inspect.isawaitable(result):
                    self._schedule(result, sink)
            except Exception as error:
                self._report(error, {"sink": _callable_name(sink)})

    def _schedule(self, awaitable: Any, sink: Sink) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            if inspect.iscoroutine(awaitable):
                awaitable.close()
            self._report(
                RuntimeError("async sink returned an awaitable but no event loop is running"),
                {"sink": _callable_name(sink)},
            )
            return

        async def run() -> None:
            try:
                await awaitable
            except Exception as error:
                self._report(error, {"sink": _callable_name(sink)})

        task = loop.create_task(run())
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    # msg is positional-only, so every other keyword, including ``level``,
    # ``msg`` and ``name``, is context: logger.info("login", level="admin").
    # ``ctx`` and ``tags`` are the parameters of those names.

    def trace(self, msg: Any, /, ctx: Any = None, tags: list[str] | None = None, **kwargs: Any) -> None:
        self._log("trace", msg, ctx, tags, kwargs)

    def debug(self, msg: Any, /, ctx: Any = None, tags: list[str] | None = None, **kwargs: Any) -> None:
        self._log("debug", msg, ctx, tags, kwargs)

    def info(self, msg: Any, /, ctx: Any = None, tags: list[str] | None = None, **kwargs: Any) -> None:
        self._log("info", msg, ctx, tags, kwargs)

    def warn(self, msg: Any, /, ctx: Any = None, tags: list[str] | None = None, **kwargs: Any) -> None:
        self._log("warn", msg, ctx, tags, kwargs)

    def error(self, msg: Any, /, ctx: Any = None, tags: list[str] | None = None, **kwargs: Any) -> None:
        """Log at error level. An exception may be passed as ctx; it is logged as ctx["error"]."""
        self._log("error", msg, ctx, tags, kwargs)

    def fatal(self, msg: Any, /, ctx: Any = None, tags: list[str] | None = None, **kwargs: Any) -> None:
        """Log at fatal level. An exception may be passed as ctx; it is logged as ctx["error"]."""
        self._log("fatal", msg, ctx, tags, kwargs)

    def child(
        self,
        name: str | None = None,
        level: LogLevel | None = None,
        ctx: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> Logger:
        child = Logger(
            name=name or self.name,
            sinks=self.sinks,
            level=level or self.level,
            pipeline=self.pipeline,
            now=self.now,
            base_context={**self.base_context, **(ctx or {})},
            base_tags=[*self.base_tags, *(tags or [])],
            on_error=self.on_error,
        )
        # Shared so flush() on either waits for calls made through the shared sinks.
        child._pending = self._pending
        return child

    async def _wait_pending(self) -> None:
        """Waits for the async sink calls scheduled before the call, on this
        and on any other running loop. A call whose loop stops or closes
        is no longer waited for: nothing would run it."""
        loop = asyncio.get_running_loop()
        current = asyncio.current_task()
        own: list[asyncio.Future[Any]] = []
        foreign: list[tuple[asyncio.AbstractEventLoop, asyncio.Future[None]]] = []
        # Other threads add and discard tasks meanwhile: read a copy (set.copy
        # is atomic), never the live set.
        for task in self._pending.copy():
            if task.done() or task is current:
                continue
            owner = task.get_loop()
            if owner is loop:
                own.append(task)
                continue
            # Another loop's task is only touched on its own thread; its
            # completion is passed back to this loop as a future.
            settled: asyncio.Future[None] = loop.create_future()

            def watch(task: asyncio.Task[Any] = task, settled: asyncio.Future[None] = settled) -> None:
                task.add_done_callback(lambda _task: _wake_threadsafe(loop, settled))

            try:
                owner.call_soon_threadsafe(watch)
            except RuntimeError:
                continue  # Its loop is closed.
            foreign.append((owner, settled))
        if own:
            await asyncio.wait(own)
        while foreign:
            await asyncio.wait([settled for _, settled in foreign], timeout=_FOREIGN_POLL_SECONDS)
            foreign = [
                (owner, settled)
                for owner, settled in foreign
                if not settled.done() and owner.is_running() and not owner.is_closed()
            ]

    async def flush(self) -> None:
        """Wait for async sink calls scheduled before the call, also on other
        threads' loops and through child loggers, then flush every sink. Sink
        failures are reported to on_error, never raised."""
        try:
            await self._wait_pending()
        except Exception as error:
            self._report(error, {})

        async def flush_one(sink: Sink) -> None:
            flush = getattr(sink, "flush", None)
            if not callable(flush):
                return
            try:
                result = flush()
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                self._report(error, {"sink": _callable_name(sink)})

        await asyncio.gather(*(flush_one(sink) for sink in self.sinks))


def _wake_threadsafe(loop: asyncio.AbstractEventLoop, future: asyncio.Future[None]) -> None:
    def wake() -> None:
        if not future.done():
            future.set_result(None)

    with contextlib.suppress(RuntimeError):  # The flushing loop is closed.
        loop.call_soon_threadsafe(wake)


def create_logger(
    name: str,
    sinks: list[Sink] | None = None,
    level: LogLevel | None = None,
    pipeline: list[PipelineStage] | None = None,
    base_context: dict[str, Any] | None = None,
    base_tags: list[str] | None = None,
    now: Callable[[], datetime] | None = None,
    on_error: ErrorHandler | None = None,
) -> Logger:
    """Create a logger. Without sinks it writes to the local console only."""
    return Logger(
        name=name,
        sinks=sinks,
        level=level,
        pipeline=pipeline,
        now=now,
        base_context=base_context,
        base_tags=base_tags,
        on_error=on_error,
    )
