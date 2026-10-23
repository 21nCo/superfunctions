"""Process-local scheduling with explicit lifecycle and timezone-aware cron."""

import asyncio
import hashlib
import json
import math
from collections.abc import Awaitable
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

from croniter import croniter

from flowfn.adapters.base import FlowAdapter
from flowfn.adapters.workflow_state import WorkflowLeaseError as WorkflowLeaseError
from flowfn.workflow.types import ExecutionStatus, WorkflowExecution

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

    def __init__(self, adapter: Optional[FlowAdapter] = None, *, lease_ms: int = 30000) -> None:
        if lease_ms < 100:
            raise ValueError("Scheduler lease must be at least 100 milliseconds")
        self._adapter = adapter
        self._lease_ms = lease_ms
        self._registrations: dict[str, asyncio.Future[None]] = {}
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

        return self._register(name, handler, next_run, data, None, {"pattern":pattern,"timezone":timezone_name})

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

        return self._register(name, handler, next_run, data, limit, {"every":every,"start_date":start_date.isoformat() if start_date else None})

    def _register(
        self, name: str, handler: Handler, next_run: Callable[[], datetime],
        data: Any, limit: Optional[int], definition: dict[str, Any],
    ) -> ScheduledJob:
        if self._closed:
            raise RuntimeError("Scheduler is closed")
        if not name or name in self._jobs:
            raise ValueError("Schedule name must be nonempty and unique")
        signature = ""
        if self._adapter is not None:
            definition = json.loads(json.dumps(dict(definition,data=data,limit=limit),sort_keys=True,allow_nan=False))
            signature = hashlib.sha256(json.dumps(definition,sort_keys=True).encode()).hexdigest()
            data = definition['data']
        loop = asyncio.get_running_loop()
        job = ScheduledJob(name, next_run())
        event = asyncio.Event()
        self._jobs[name] = job
        self._events[name] = event
        if self._adapter is None:
            self._tasks[name] = loop.create_task(self._run(job, event, handler, next_run, data, limit))
        else:
            self._registrations[name] = loop.create_future()
            self._tasks[name] = loop.create_task(self._run_persistent(job,handler,next_run,data,limit,definition,signature))
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

    async def ready(self) -> None:
        """Wait until all registered definitions are durably installed."""
        await asyncio.gather(*self._registrations.values())

    @staticmethod
    def _snapshot(record: WorkflowExecution) -> ScheduledJob:
        state = record.state
        return ScheduledJob(state['name'],datetime.fromisoformat(state['next_run']) if state.get('next_run') else None,
                            state.get('runs',0),state.get('paused',False),state.get('last_error'))

    @staticmethod
    def _next_persistent(record: WorkflowExecution) -> datetime:
        definition = record.state['definition']
        now = datetime.now(timezone.utc)
        if 'pattern' in definition:
            zone = ZoneInfo(definition['timezone'])
            return croniter(definition['pattern'],now.astimezone(zone)).get_next(datetime)
        due = datetime.fromisoformat(record.state['next_run']).timestamp()
        interval = definition['every']/1000
        target = due + interval
        if target <= now.timestamp():
            target += (math.floor((now.timestamp()-target)/interval)+1)*interval
        return datetime.fromtimestamp(target,timezone.utc)

    async def _run_persistent(self, job: ScheduledJob, handler: Handler, next_run: Callable[[], datetime],
                              data: Any, limit: Optional[int], definition: dict[str, Any], signature: str) -> None:
        assert self._adapter is not None
        adapter = self._adapter
        identity = '__schedule__:' + job.name
        owner: Optional[WorkflowExecution] = None
        heartbeat: Optional[asyncio.Task[None]] = None
        registration = self._registrations[job.name]
        now = int(datetime.now(timezone.utc).timestamp()*1000)
        record = WorkflowExecution(id=identity,workflow_id='__scheduler__',input=data,
                    definition_hash=signature,status=ExecutionStatus.RUNNING,started_at=now,created_at=now,updated_at=now,
                    state={'name':job.name,'definition':definition,'next_run':job.next_run.isoformat() if job.next_run else None,'runs':0,'paused':False})
        try:
            stored = await adapter.transition_workflow_state(identity,'create',{'execution':record})
            if stored is None or stored.definition_hash != signature:
                raise ValueError('Persisted schedule definition differs; use a new schedule name')
            registration.set_result(None)
            while not self._closed:
                stored = await adapter.load_workflow_state(identity)
                if stored is None or stored.status != ExecutionStatus.RUNNING:
                    return
                self._jobs[job.name] = self._snapshot(stored)
                if stored.state.get('paused'):
                    await asyncio.sleep(.05)
                    continue
                owner = await adapter.transition_workflow_state(identity,'claim',{
                    'workflow_id':'__scheduler__','version':'1','definition_hash':signature,'lease_ms':self._lease_ms})
                if owner is None:
                    await asyncio.sleep(min(.1,self._lease_ms/3000))
                    continue
                task = asyncio.current_task()

                async def renew(record: WorkflowExecution, owner_task: Optional[asyncio.Task[Any]] = task) -> None:
                    while True:
                        await asyncio.sleep(self._lease_ms/3000)
                        try:
                            refreshed = await adapter.transition_workflow_state(identity,'renew',{'token':record.lease_token,'lease_ms':self._lease_ms})
                            if refreshed is not None:
                                continue
                        except Exception:
                            pass
                        if owner_task is not None:
                            owner_task.cancel()
                        return

                heartbeat = asyncio.create_task(renew(owner))
                try:
                    while True:
                        current = await adapter.load_workflow_state(identity)
                        if current is None or current.lease_token != owner.lease_token or current.status != ExecutionStatus.RUNNING:
                            return
                        if current.state.get('paused'):
                            break
                        due = datetime.fromisoformat(owner.state['next_run']).timestamp()
                        delay = due-datetime.now(timezone.utc).timestamp()
                        if delay <= 0:
                            try:
                                await handler(json.loads(json.dumps(data)))
                                owner.state['last_error'] = None
                            except Exception as exc:
                                owner.state['last_error'] = str(exc)
                            owner.state['runs'] += 1
                            if limit is not None and owner.state['runs'] >= limit:
                                owner.state['next_run'] = None
                                owner.status = ExecutionStatus.COMPLETED
                            else:
                                owner.state['next_run'] = self._next_persistent(owner).isoformat()
                            await adapter.save_workflow_state(identity,owner)
                            self._jobs[job.name] = self._snapshot(owner)
                            break
                        await asyncio.sleep(min(.05,delay))
                finally:
                    heartbeat.cancel()
                    await asyncio.gather(heartbeat,return_exceptions=True)
                    heartbeat = None
                    await adapter.transition_workflow_state(identity,'release',{'token':owner.lease_token})
                    owner = None
        except asyncio.CancelledError:
            if not registration.done():
                registration.cancel()
            raise
        except Exception as exc:
            if not registration.done():
                registration.set_exception(exc)
            else:
                job.last_error = str(exc)
                asyncio.get_running_loop().call_exception_handler({'message':'Persistent schedule stopped','exception':exc,'schedule':job.name})
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
                await asyncio.gather(heartbeat,return_exceptions=True)
            if owner is not None:
                await adapter.transition_workflow_state(identity,'release',{'token':owner.lease_token})

    async def list(self) -> list[ScheduledJob]:
        if self._adapter is not None and not self._closed:
            await self.ready()
            records = await self._adapter.list_workflow_states('__scheduler__')
            return [self._snapshot(record) for record in records if record.status != ExecutionStatus.CANCELLED]
        return [replace(job) for job in self._jobs.values()]

    async def pause(self, name: str) -> None:
        if self._adapter is not None:
            await self.ready()
            await self._adapter.transition_workflow_state('__schedule__:'+name,'schedule_control',{'paused':True})
        if name in self._jobs:
            self._jobs[name].paused = True
            self._events[name].set()

    async def resume(self, name: str) -> None:
        if self._adapter is not None:
            await self.ready()
            await self._adapter.transition_workflow_state('__schedule__:'+name,'schedule_control',{'paused':False})
        if name in self._jobs:
            self._jobs[name].paused = False
            self._events[name].set()

    async def cancel(self, name: str) -> None:
        if self._adapter is not None:
            await self.ready()
            await self._adapter.transition_workflow_state('__schedule__:'+name,'cancel',{'workflow_id':'__scheduler__'})
        task = self._tasks.pop(name, None)
        self._jobs.pop(name, None)
        self._events.pop(name, None)
        if task is not None:
            task.cancel()
            if task is not asyncio.current_task():
                await asyncio.gather(task, return_exceptions=True)

    async def close(self) -> None:
        self._closed = True
        if self._adapter is None:
            for name in list(self._tasks):
                await self.cancel(name)
        else:
            for task in self._tasks.values():
                task.cancel()
            await asyncio.gather(*self._tasks.values(),return_exceptions=True)
            self._tasks.clear()
            self._jobs.clear()
            for registration in self._registrations.values():
                if not registration.done():
                    registration.cancel()
