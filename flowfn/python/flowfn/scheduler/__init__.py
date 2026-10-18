"""Process-local scheduling with explicit lifecycle and timezone-aware cron."""

import asyncio
import math
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo

from croniter import croniter

Handler = Callable[[Any], Awaitable[Any]]


@dataclass
class ScheduledJob:
    name: str
    next_run: Optional[datetime]
    runs: int = 0
    paused: bool = False
    last_error: Optional[str] = None


class Scheduler:
    """Runs callbacks serially per schedule, without overlapping invocations.

    State is process-local. Shutdown cancels and awaits running callbacks. Missed
    intervals are skipped, rather than replayed in a burst after a slow callback.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, ScheduledJob] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._events: dict[str, asyncio.Event] = {}
        self._closed = False

    def schedule(
        self, name: str, pattern: str, handler: Handler, *,
        timezone_name: str = "UTC", data: Any = None,
    ) -> ScheduledJob:
        """Schedule a five-field cron expression in an IANA timezone."""
        if len(pattern.split()) != 5 or not croniter.is_valid(pattern):
            raise ValueError("Expected a valid five-field cron expression")
        zone = ZoneInfo(timezone_name)

        def next_run() -> datetime:
            return croniter(pattern, datetime.now(zone)).get_next(datetime)

        return self._register(name, handler, next_run, data, None)

    def repeat(
        self, name: str, every: float, handler: Handler, *,
        start_date: Optional[datetime] = None, limit: Optional[int] = None,
        data: Any = None,
    ) -> ScheduledJob:
        """Repeat every ``every`` milliseconds, optionally with a run limit."""
        if not math.isfinite(every) or every <= 0:
            raise ValueError("every must be positive and finite")
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0):
            raise ValueError("limit must be a positive integer")
        if start_date is not None and start_date.utcoffset() is None:
            raise ValueError("start_date must be timezone-aware")
        interval = every / 1000
        target = start_date.timestamp() if start_date else datetime.now(timezone.utc).timestamp() + interval

        def next_run() -> datetime:
            nonlocal target
            now = datetime.now(timezone.utc).timestamp()
            if target < now:
                target += (math.floor((now - target) / interval) + 1) * interval
            result = datetime.fromtimestamp(target, timezone.utc)
            target += interval
            return result

        return self._register(name, handler, next_run, data, limit)

    def _register(
        self, name: str, handler: Handler, next_run: Callable[[], datetime],
        data: Any, limit: Optional[int],
    ) -> ScheduledJob:
        if self._closed:
            raise RuntimeError("Scheduler is closed")
        if not name or name in self._jobs:
            raise ValueError("Schedule name must be nonempty and unique")
        loop = asyncio.get_running_loop()
        job = ScheduledJob(name, next_run())
        event = asyncio.Event()
        self._jobs[name] = job
        self._events[name] = event
        self._tasks[name] = loop.create_task(self._run(job, event, handler, next_run, data, limit))
        return replace(job)

    async def _run(
        self, job: ScheduledJob, event: asyncio.Event, handler: Handler,
        next_run: Callable[[], datetime], data: Any, limit: Optional[int],
    ) -> None:
        while job.next_run is not None:
            if job.paused:
                await event.wait()
                event.clear()
                continue
            delay = max(0.0, job.next_run.timestamp() - datetime.now(timezone.utc).timestamp())
            try:
                await asyncio.wait_for(event.wait(), delay)
                event.clear()
                continue
            except asyncio.TimeoutError:
                pass
            if job.paused:
                continue
            try:
                await handler(data)
                job.last_error = None
            except Exception as exc:
                job.last_error = str(exc)
            job.runs += 1
            job.next_run = None if limit is not None and job.runs >= limit else next_run()

    async def list(self) -> list[ScheduledJob]:
        return [replace(job) for job in self._jobs.values()]

    async def pause(self, name: str) -> None:
        self._jobs[name].paused = True
        self._events[name].set()

    async def resume(self, name: str) -> None:
        self._jobs[name].paused = False
        self._events[name].set()

    async def cancel(self, name: str) -> None:
        task = self._tasks.pop(name, None)
        self._jobs.pop(name, None)
        self._events.pop(name, None)
        if task is not None:
            task.cancel()
            if task is not asyncio.current_task():
                await asyncio.gather(task, return_exceptions=True)

    async def close(self) -> None:
        self._closed = True
        for name in list(self._tasks):
            await self.cancel(name)
