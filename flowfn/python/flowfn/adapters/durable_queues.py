"""Shared durable queue state transitions and lease ownership rules."""
import asyncio
import json
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import asdict
from typing import Any, Optional, Callable
from flowfn.adapters.memory import MemoryAdapter
from flowfn.queue.dlq import DLQJob, DLQManager
from flowfn.queue.types import Job, JobOptions, JobStatus, QueueStats, BackoffType, JobLeaseError


class DurableQueues(ABC):
    def _setup_queues(self, reclaim_after_ms: int, strategies: Optional[dict[str, Callable[[int], int]]]) -> None:
        self.backoff_strategies = dict(strategies or {})
        self.reclaim_after_ms = reclaim_after_ms
        self._closed = False
        self._job_events: dict[tuple[str, str, Optional[str]], asyncio.Event] = {}
        self._job_heartbeats: dict[tuple[str, str, Optional[str]], asyncio.Task[None]] = {}

    @abstractmethod
    async def _read_queue_state(self) -> Optional[str]: ...

    @abstractmethod
    async def _transition(self, method: str, *args: Any) -> Any: ...

    async def _close_queues(self) -> None:
        self._closed = True
        for event in self._job_events.values():
            event.set()
        for task in self._job_heartbeats.values():
            task.cancel()
        await asyncio.gather(*self._job_heartbeats.values(), return_exceptions=True)
        self._job_heartbeats.clear()
        self._job_events.clear()

    @staticmethod
    def _decode(raw: Optional[str]) -> MemoryAdapter:
        adapter = MemoryAdapter()
        state = json.loads(raw) if raw else {}
        for name, jobs in state.get('queues', {}).items():
            adapter._queues[name] = [Job.model_validate(job) for job in jobs]
        for record in state.get('dead_letters', []):
            record['options'] = JobOptions.model_validate(record['options'])
            item = DLQJob(**record)
            adapter._dead_letters[(item.original_queue, item.id)] = item
        for queue, identity, status in state.get('dependencies', []):
            adapter._dependency_results[(queue, identity)] = JobStatus(status)
        return adapter

    @staticmethod
    def _encode(adapter: MemoryAdapter) -> str:
        dead_letters = []
        for record in adapter._dead_letters.values():
            value = asdict(record)
            value['options'] = record.options.model_dump(mode='json')
            dead_letters.append(value)
        return json.dumps({
            'queues': {name: [job.model_dump(mode='json') for job in jobs]
                       for name, jobs in adapter._queues.items()},
            'dead_letters': dead_letters,
            'dependencies': [[queue, identity, status.value]
                             for (queue, identity), status in adapter._dependency_results.items()],
        }, allow_nan=False)

    async def _apply(self, adapter: MemoryAdapter, method: str, args: tuple[Any, ...], now: int) -> Any:
        adapter._now = lambda: now  # type: ignore[method-assign]
        if method == 'enqueue':
            incoming = args[1]
            if incoming._relative_delay_ms is not None:
                incoming.timestamp = now
                incoming.available_at = now + incoming._relative_delay_ms
            elif incoming.delay == 0 and (incoming.available_at is None or incoming.available_at <= incoming.timestamp):
                incoming.available_at = now
        if method == 'dequeue':
            for candidate in adapter._queues[args[0]]:
                if candidate.state == JobStatus.ACTIVE and (candidate.lease_expires_at or 0) <= now:
                    candidate.state = JobStatus.WAITING
                    candidate.lease_token = None
                    candidate.lease_expires_at = None
        if method in ('update_job', '_renew_job'):
            queue, incoming = args
            stored = next((entry for entry in adapter._queues[queue] if entry.id == incoming.id), None)
            if stored is None or stored.state != JobStatus.ACTIVE or stored.lease_token != incoming.lease_token or (stored.lease_expires_at or 0) <= now:
                raise JobLeaseError('Job lease has expired or ownership changed')
        if method == 'update_job' and incoming._relative_delay_ms is not None and incoming.state in (JobStatus.WAITING, JobStatus.DELAYED):
            incoming.available_at = now + incoming._relative_delay_ms
        if method == '_renew_job':
            assert stored is not None
            stored.lease_expires_at = now + self.reclaim_after_ms
            result = None
        else:
            if method == 'update_job' and args[1].state == JobStatus.ACTIVE:
                args[1].lease_expires_at = now + self.reclaim_after_ms
            result = await getattr(adapter, method)(*args)
            if method == 'enqueue':
                result._enqueue_created = args[1]._enqueue_created
        if method == 'dequeue' and result is not None:
            self._restore_backoff(result)
            result.processed_on = now
            result.lease_token = uuid.uuid4().hex
            result.lease_expires_at = now + self.reclaim_after_ms
        return result

    def _restore_backoff(self, job: Job) -> None:
        if job.opts.backoff and job.opts.backoff.type == BackoffType.CUSTOM:
            strategy = self.backoff_strategies.get(job.name)
            if strategy is None:
                raise ValueError(f'Configure backoff_strategies for job name: {job.name}')
            job.opts.backoff.strategy = strategy

    async def enqueue(self, queue: str, job: Job) -> Job:
        self._restore_backoff(job)
        json.dumps(job.model_dump(mode='json'),allow_nan=False)
        incoming = job.model_copy(deep=True)
        if incoming._relative_delay_ms is None and incoming.available_at is None:
            incoming._relative_delay_ms = incoming.delay
        result: Job = await self._transition('enqueue', queue, incoming)
        job._relative_delay_ms = None
        result._relative_delay_ms = None
        job._enqueue_created = result._enqueue_created
        return result

    def lease_loss_event(self, queue: str, job: Job) -> Optional[asyncio.Event]:
        return self._job_events.get((queue,job.id,job.lease_token))

    async def release_job_lease(self, queue: str, job: Job) -> None:
        key = (queue,job.id,job.lease_token)
        task = self._job_heartbeats.pop(key,None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
        self._job_events.pop(key,None)

    async def update_job(self, queue: str, job: Job) -> None:
        json.dumps(job.model_dump(mode='json'),allow_nan=False)
        key = (queue,job.id,job.lease_token)
        try:
            await self._transition('update_job', queue, job.model_copy(deep=True))
            job._relative_delay_ms = None
        except JobLeaseError:
            event = self._job_events.get(key)
            if event is not None:
                event.set()
            raise
        finally:
            if job.state != JobStatus.ACTIVE:
                heartbeat = self._job_heartbeats.pop(key,None)
                if heartbeat is not None:
                    heartbeat.cancel()
                    await asyncio.gather(heartbeat,return_exceptions=True)
                self._job_events.pop(key,None)

    async def dequeue(self, queue: str) -> Optional[Job]:
        started = time.monotonic()
        result: Optional[Job] = await self._transition('dequeue', queue)
        if result is not None:
            key = (queue,result.id,result.lease_token)
            for previous,event in list(self._job_events.items()):
                if previous[:2] == key[:2] and previous != key:
                    event.set()
            event = asyncio.Event()
            if time.monotonic() >= started+self.reclaim_after_ms/1000:
                event.set()
            self._job_events[key] = event
            task = asyncio.create_task(self._renew_job(queue,result.model_copy(deep=True),event,started+self.reclaim_after_ms/1000))
            self._job_heartbeats[key] = task
            def finished(done: asyncio.Task[None]) -> None:
                if self._job_heartbeats.get(key) is done:
                    self._job_heartbeats.pop(key,None)
            task.add_done_callback(finished)
        return result

    async def _renew_job(self, queue: str, job: Job, lost: asyncio.Event, deadline: float) -> None:
        try:
            while not self._closed:
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    lost.set()
                    return
                await asyncio.sleep(min(self.reclaim_after_ms/3000,remaining))
                retry_delay = min(.05,self.reclaim_after_ms/6000)
                while not self._closed:
                    remaining = deadline-time.monotonic()
                    if remaining <= 0:
                        lost.set()
                        return
                    started = time.monotonic()
                    try:
                        await asyncio.wait_for(self._transition('_renew_job',queue,job),remaining)
                        # Starting the bound before the request is conservative:
                        # its server-side lease cannot begin before this instant.
                        deadline = started+self.reclaim_after_ms/1000
                        break
                    except JobLeaseError:
                        lost.set()
                        return
                    except Exception:
                        await asyncio.sleep(min(retry_delay,max(0,deadline-time.monotonic())))
                        retry_delay = min(retry_delay*2,max(.05,self.reclaim_after_ms/3000))
        finally:
            if self._closed:
                lost.set()

    async def get_queue_stats(self, queue: str) -> QueueStats:
        return await self._decode(await self._read_queue_state()).get_queue_stats(queue)

    async def get_jobs(self, queue: str, status: JobStatus) -> list[Job]:
        return await self._decode(await self._read_queue_state()).get_jobs(queue, status)

    async def get_all_jobs(self, queue: str) -> list[Job]:
        return await self._decode(await self._read_queue_state()).get_all_jobs(queue)

    async def clean_jobs(self, queue: str, grace: int, status: JobStatus) -> int:
        result: int = await self._transition('clean_jobs', queue, grace, status)
        return result

    async def save_dead_letter(self, record: DLQJob) -> None:
        await self._transition('save_dead_letter', record)

    async def get_dead_letters(self) -> list[DLQJob]:
        return await self._decode(await self._read_queue_state()).get_dead_letters()

    async def delete_dead_letter(self, queue: str, job_id: str) -> None:
        await self._transition('delete_dead_letter', queue, job_id)

    async def retry_dead_letter(self, queue: str, job_id: str) -> Job:
        result: Job = await self._transition('retry_dead_letter', queue, job_id)
        return result
