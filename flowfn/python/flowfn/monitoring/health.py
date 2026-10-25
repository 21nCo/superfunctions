"""Health monitoring implementation."""

import inspect
import time
from collections.abc import Awaitable
from copy import deepcopy
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Optional


class HealthStatus(str, Enum):
    """Health check status."""

    PASS = "pass"
    FAIL = "fail"
    WARN = "warn"


@dataclass
class HealthCheck:
    """Individual health check result."""

    name: str
    status: HealthStatus
    message: Optional[str] = None
    response_time: Optional[int] = None
    details: Optional[dict[str, Any]] = None


@dataclass
class HealthCheckResult:
    """Overall health check result."""

    healthy: bool
    timestamp: int
    checks: list[HealthCheck]
    details: Optional[dict[str, Any]] = None


HealthCheckFunc = Callable[[], Awaitable[HealthCheck]]


class HealthChecker:
    """Health check manager."""

    def __init__(self) -> None:
        self._checks: dict[str, HealthCheckFunc] = {}
        self._start_time = self._now()
        self._add_default_checks()

    def _add_default_checks(self) -> None:
        """Add default health checks."""

        # Uptime check
        async def uptime_check() -> HealthCheck:
            return HealthCheck(
                name="uptime",
                status=HealthStatus.PASS,
                details={"uptime": self._now() - self._start_time, "start_time": self._start_time},
            )

        self.add_check("uptime", uptime_check)

        # Memory check
        async def memory_check() -> HealthCheck:
            try:
                import psutil

                mem = psutil.virtual_memory()
                percent = mem.percent

                return HealthCheck(
                    name="memory",
                    status=HealthStatus.WARN if percent > 90 else HealthStatus.PASS,
                    message="High memory usage" if percent > 90 else None,
                    details={
                        "used_mb": mem.used // (1024 * 1024),
                        "total_mb": mem.total // (1024 * 1024),
                        "usage_percent": round(percent, 2),
                    },
                )
            except ImportError:
                return HealthCheck(name="memory", status=HealthStatus.WARN, message="Install flowfn[monitoring] for memory measurements")

        self.add_check("memory", memory_check)

    def add_check(self, name: str, checker: HealthCheckFunc) -> None:
        """Add a health check."""
        self._checks[name] = checker

    def remove_check(self, name: str) -> None:
        """Remove a health check."""
        self._checks.pop(name, None)

    async def check(self) -> HealthCheckResult:
        """Perform all health checks."""
        results: list[HealthCheck] = []
        all_healthy = True

        for name, checker in self._checks.items():
            try:
                start = self._now()
                result = await checker()
                result.response_time = self._now() - start
                results.append(result)

                if result.status == HealthStatus.FAIL:
                    all_healthy = False

            except Exception as error:
                results.append(HealthCheck(name=name, status=HealthStatus.FAIL, message=str(error)))
                all_healthy = False

        return HealthCheckResult(healthy=all_healthy, timestamp=self._now(), checks=results)

    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)


class EventSeverity(str, Enum):
    """Event severity levels."""

    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class EventCategory(str, Enum):
    """Event categories."""

    QUEUE = "queue"
    STREAM = "stream"
    WORKFLOW = "workflow"
    SYSTEM = "system"


@dataclass
class TrackedEvent:
    """Tracked event."""

    id: str
    type: str
    category: EventCategory
    severity: EventSeverity
    message: str
    timestamp: int
    metadata: Optional[dict[str, Any]] = None


class EventTracker:
    """Event tracking for monitoring."""

    def __init__(self, observer: Any = None) -> None:
        self._observer = observer
        self._listeners: dict[str, list[Callable[..., Any]]] = {}
        self._events: list[TrackedEvent] = []
        self._max_events = 10000

    def on(self, event_type: str, listener: Callable[..., Any]) -> Callable[[], None]:
        """Register a local lifecycle listener and return its unsubscribe function."""
        if not event_type or not callable(listener):
            raise ValueError("An event name and callable listener are required")
        self._listeners.setdefault(event_type, []).append(listener)
        def unsubscribe() -> None:
            self.off(event_type, listener)
        return unsubscribe

    def off(self, event_type: str, listener: Callable[..., Any]) -> None:
        listeners = self._listeners.get(event_type, [])
        if listener in listeners:
            listeners.remove(listener)
        if not listeners:
            self._listeners.pop(event_type, None)

    async def emit(self, event_type: str, metadata: dict[str, Any]) -> None:
        category = "queue" if event_type.startswith("job:") else event_type.split(":", 1)[0]
        severity = "error" if event_type.endswith(":failed") else "warn" if event_type.endswith(":stalled") else "info"
        self.track({"type": event_type, "category": category, "severity": severity,
                    "message": event_type, "metadata": metadata})
        for listener in list(self._listeners.get(event_type, [])):
            async def invoke(callback: Callable[..., Any] = listener) -> None:
                result = callback(deepcopy(metadata))
                if inspect.isawaitable(result):
                    await result
            try:
                if self._observer is not None:
                    await self._observer.run("flowfn.event." + event_type, {}, invoke)
                else:
                    await invoke()
            except Exception:
                # A notification failure cannot roll back committed work.
                pass

    def track(self, event_data: dict[str, Any]) -> None:
        """Track an event."""
        import uuid

        event = TrackedEvent(
            id=f"evt_{self._now()}_{uuid.uuid4().hex[:7]}",
            type=event_data["type"],
            category=EventCategory(event_data["category"]),
            severity=EventSeverity(event_data["severity"]),
            message=event_data["message"],
            timestamp=self._now(),
            metadata=deepcopy(event_data.get("metadata")),
        )

        self._events.append(event)

        # Trim if exceeds max
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events :]

    def get_events(self, filter: Optional[dict[str, Any]] = None) -> list[TrackedEvent]:
        """Get events with optional filtering."""
        filtered = deepcopy(self._events)

        if not filter:
            return filtered

        if "category" in filter:
            filtered = [e for e in filtered if e.category == filter["category"]]

        if "severity" in filter:
            filtered = [e for e in filtered if e.severity == filter["severity"]]

        if "since" in filter:
            filtered = [e for e in filtered if e.timestamp >= filter["since"]]

        if "type" in filter:
            filtered = [e for e in filtered if e.type == filter["type"]]

        if "limit" in filter:
            limit = filter["limit"]
            if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
                raise ValueError("Event limit must be a nonnegative integer")
            filtered = filtered[-limit:] if limit else []

        return filtered

    def cleanup(self, max_age: int) -> int:
        """Clean old events."""
        now = self._now()
        before = len(self._events)
        self._events = [e for e in self._events if now - e.timestamp <= max_age]
        return before - len(self._events)

    def clear(self) -> None:
        """Clear all events."""
        self._events.clear()

    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)
