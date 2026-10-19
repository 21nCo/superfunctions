import asyncio
import os
import inspect
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union, Callable, Set

from .serialization import bound_event

from .types import (
    DEFAULT_VERSION,
    ErrorHandler,
    LOG_LEVEL_VALUES,
    ChildLoggerOptions,
    LogEvent,
    LogCorrelation,
    LoggerOptions,
    LogLevel,
    PipelineStage,
    Sink,
)

def default_now() -> datetime:
    return datetime.now(timezone.utc)

def get_default_level() -> LogLevel:
    env = os.environ.get("ENV", os.environ.get("NODE_ENV", "development"))
    return "info" if env == "production" else "debug"

class _ErrorReporter:
    def __init__(self, callback: Optional[ErrorHandler]) -> None:
        self.callback = callback
        self.reporting = False

    def report(self, error: BaseException, context: Dict[str, str]) -> None:
        if self.reporting:
            return
        self.reporting = True
        try:
            if self.callback is not None:
                try:
                    self.callback(error, context)
                except Exception:
                    print("[logfn internal error] error callback failed", file=sys.stderr)
            else:
                print(f"[logfn internal error] {context}: {type(error).__name__}", file=sys.stderr)
        finally:
            self.reporting = False


class _DeliveryState:
    def __init__(self, reporter: _ErrorReporter) -> None:
        self.reporter = reporter
        self.contexts: Dict[asyncio.Future[Any], Dict[str, str]] = {}
        self.pending: Set[asyncio.Future[Any]] = set()
        self.error: Optional[BaseException] = None

    def completed(self, task: asyncio.Future[Any]) -> None:
        self.pending.discard(task)
        context = self.contexts.pop(task, {"sink": "unknown"})
        error = asyncio.CancelledError() if task.cancelled() else task.exception()
        if error is not None:
            if self.error is None:
                self.error = error
            self.reporter.report(error, context)


class Logger:
    def __init__(
        self,
        name: str,
        sinks: List[Sink],
        level: Optional[LogLevel] = None,
        pipeline: Optional[List[PipelineStage]] = None,
        now: Optional[Callable[[], datetime]] = None,
        base_context: Optional[Dict[str, Any]] = None,
        base_tags: Optional[List[str]] = None,
        on_error: Optional[ErrorHandler] = None,
        correlation: Optional[LogCorrelation] = None,
    ):
        self._reporter = _ErrorReporter(on_error)
        self._delivery = _DeliveryState(self._reporter)
        self.name = name
        self.sinks = sinks
        self.level = level or get_default_level()
        self.pipeline = pipeline or []
        self.now = now or default_now
        self.base_context = base_context or {}
        self.base_tags = base_tags or []
        self.correlation: LogCorrelation = {**(correlation or {})}
        
        if not sinks:
            # We don't throw here to avoid breaking apps, but it's bad practice
            print("Warning: Logger created without sinks", file=sys.stderr)

    def should_log(self, level: LogLevel) -> bool:
        return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[self.level]

    def _log(
        self,
        level: LogLevel,
        msg: str,
        ctx: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> None:
        if not self.should_log(level):
            return

        # Merge kwargs into ctx for convenience: logger.info("msg", user_id="1")
        if kwargs:
            ctx = {**(ctx or {}), **kwargs}

        event: LogEvent = {
            "ts": self.now().isoformat(),
            "level": level,
            "msg": msg,
            "name": self.name,
            "version": DEFAULT_VERSION,
        }

        if "traceId" in self.correlation:
            event["traceId"] = self.correlation["traceId"]
        if "spanId" in self.correlation:
            event["spanId"] = self.correlation["spanId"]
        if "requestId" in self.correlation:
            event["requestId"] = self.correlation["requestId"]
        if "userId" in self.correlation:
            event["userId"] = self.correlation["userId"]
        if "tenantId" in self.correlation:
            event["tenantId"] = self.correlation["tenantId"]

        # Merge context
        merged_ctx = {**self.base_context}
        if ctx:
            merged_ctx.update(ctx)
        if merged_ctx:
            event["ctx"] = merged_ctx

        # Merge tags
        merged_tags = list(self.base_tags)
        if tags:
            merged_tags.extend(tags)
        if merged_tags:
            event["tags"] = merged_tags

        # Pipeline
        current_event: Optional[LogEvent] = event
        for stage in self.pipeline:
            try:
                if current_event:
                    current_event = stage(current_event)
            except Exception as e:
                self._reporter.report(e, {"stage": getattr(stage, "__name__", type(stage).__name__)})
        
        if not current_event:
            return

        # Sinks
        batch = [bound_event(current_event)]
        for sink in self.sinks:
            try:
                res = sink(batch)
                if inspect.isawaitable(res):
                    try:
                        asyncio.get_running_loop()
                    except RuntimeError:
                        if inspect.iscoroutine(res):
                            res.close()
                        error = RuntimeError("Async sink requires a running event loop")
                        if self._delivery.error is None:
                            self._delivery.error = error
                        self._reporter.report(error, {"sink": getattr(sink, "__name__", type(sink).__name__)})
                    else:
                        task = asyncio.ensure_future(res)
                        self._delivery.pending.add(task)
                        self._delivery.contexts[task] = {"sink": getattr(sink, "__name__", type(sink).__name__)}
                        task.add_done_callback(self._delivery.completed)
            except Exception as e:
                self._reporter.report(e, {"sink": getattr(sink, "__name__", type(sink).__name__)})

    def trace(self, msg: str, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, **kwargs: Any) -> None:
        self._log("trace", msg, ctx, tags, **kwargs)

    def debug(self, msg: str, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, **kwargs: Any) -> None:
        self._log("debug", msg, ctx, tags, **kwargs)

    def info(self, msg: str, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, **kwargs: Any) -> None:
        self._log("info", msg, ctx, tags, **kwargs)

    def warn(self, msg: str, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, **kwargs: Any) -> None:
        self._log("warn", msg, ctx, tags, **kwargs)

    def error(self, msg: str, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, **kwargs: Any) -> None:
        self._log("error", msg, ctx, tags, **kwargs)

    def fatal(self, msg: str, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, **kwargs: Any) -> None:
        self._log("fatal", msg, ctx, tags, **kwargs)

    def child(self, name: Optional[str] = None, level: Optional[LogLevel] = None, ctx: Optional[Dict[str, Any]] = None, tags: Optional[List[str]] = None, correlation: Optional[LogCorrelation] = None) -> 'Logger':
        new_name = name or self.name
        new_level = level or self.level
        new_ctx = {**self.base_context}
        if ctx:
            new_ctx.update(ctx)
        new_tags = list(self.base_tags)
        if tags:
            new_tags.extend(tags)
            
        child = Logger(
            name=new_name,
            sinks=self.sinks,
            level=new_level,
            pipeline=self.pipeline,
            now=self.now,
            base_context=new_ctx,
            base_tags=new_tags,
            correlation={**self.correlation, **(correlation or {})},
        )
        child._reporter = self._reporter
        child._delivery = self._delivery
        return child

    async def flush(self) -> None:
        # Parent and children share delivery ownership. Shield application sink
        # tasks so cancelling a flush waiter does not discard accepted events.
        while self._delivery.pending:
            await asyncio.gather(
                *(asyncio.shield(task) for task in tuple(self._delivery.pending)),
                return_exceptions=True,
            )

        async def flush_sink(sink: Sink) -> None:
            flush = getattr(sink, "flush", None)
            if flush is not None:
                try:
                    result = flush()
                    if inspect.isawaitable(result):
                        await result
                except Exception as error:
                    self._reporter.report(error, {"sink": getattr(sink, "__name__", type(sink).__name__), "phase": "flush"})
                    raise

        results = await asyncio.gather(
            *(flush_sink(sink) for sink in self.sinks), return_exceptions=True
        )
        error = self._delivery.error
        self._delivery.error = None
        for result in results:
            if isinstance(result, BaseException) and error is None:
                error = result
        if error is not None:
            raise error

def create_logger(
    name: str,
    sinks: List[Sink],
    level: Optional[LogLevel] = None,
    pipeline: Optional[List[PipelineStage]] = None,
    base_context: Optional[Dict[str, Any]] = None,
    base_tags: Optional[List[str]] = None,
    on_error: Optional[ErrorHandler] = None,
    correlation: Optional[LogCorrelation] = None,
) -> Logger:
    return Logger(
        name=name,
        sinks=sinks,
        level=level,
        pipeline=pipeline,
        base_context=base_context,
        base_tags=base_tags,
        on_error=on_error,
        correlation=correlation,
    )
