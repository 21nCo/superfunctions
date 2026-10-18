"""Optional, application-owned tracing with failure-isolated error callbacks."""

import asyncio
import importlib
import inspect
from typing import Any, Awaitable, Callable, Optional, TypeVar

T = TypeVar("T")


class OperationObserver:
    def __init__(self, options: Optional[dict[str, Any]] = None, on_error: Any = None):
        options = options or {}
        self.on_error = on_error
        self.tracer: Any = None
        if not options.get("enabled", False):
            return
        provider = options.get("provider", "opentelemetry")
        if provider not in ("opentelemetry", "custom"):
            raise ValueError("Unknown telemetry provider")
        self.tracer = options.get("tracer")
        if self.tracer is None:
            if provider == "custom":
                raise ValueError("Custom telemetry requires a tracer")
            try:
                trace = importlib.import_module("opentelemetry.trace")
            except ImportError as exc:
                raise ImportError("Install flowfn[telemetry] to enable OpenTelemetry") from exc
            self.tracer = trace.get_tracer(
                "flowfn", "0.0.1", tracer_provider=options.get("tracer_provider")
            )
        if not callable(getattr(self.tracer, "start_as_current_span", None)):
            raise ValueError("Telemetry tracer must implement start_as_current_span")

    async def run(
        self, name: str, attributes: dict[str, str], operation: Callable[[], Awaitable[T]]
    ) -> T:
        manager: Any = None
        if self.tracer is not None:
            try:
                candidate = self.tracer.start_as_current_span(name, attributes=attributes)
                candidate.__enter__()
                manager = candidate
            except Exception:
                # Instrumentation failure must never execute application work twice.
                pass
        error: Optional[BaseException] = None
        try:
            return await operation()
        except BaseException as exc:
            error = exc
            if not isinstance(exc, asyncio.CancelledError) and self.on_error is not None:
                try:
                    result = self.on_error(exc, {"operation": name, **attributes})
                    if inspect.isawaitable(result):
                        await result
                except Exception:
                    pass
            raise
        finally:
            if manager is not None:
                try:
                    manager.__exit__(
                        type(error) if error else None,
                        error,
                        error.__traceback__ if error else None,
                    )
                except Exception:
                    pass


class ObservedAdapter:
    """Delegate the adapter contract without modifying caller-owned instances."""

    def __init__(self, adapter: Any, observer: OperationObserver):
        self._target = adapter
        self._observer = observer

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._target, name)
        if name.startswith("_") or not inspect.iscoroutinefunction(value):
            return value

        async def invoke(*args: Any, **kwargs: Any) -> Any:
            # Arguments may contain payloads, URLs or credentials; never export them.
            return await self._observer.run(
                "flowfn.adapter." + name, {}, lambda: value(*args, **kwargs)
            )

        return invoke
