"""Dead-letter inspection and recovery backed by the configured adapter."""

import time
from collections.abc import Awaitable
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from flowfn.adapters.base import FlowAdapter
from flowfn.queue.types import Job, JobOptions


@dataclass
class DLQJob:
    id: str
    name: str
    data: Any
    original_queue: str
    dlq_reason: str
    dlq_timestamp: int
    errors: list[str] = field(default_factory=list)
    attempts_made: int = 0
    failed_reason: Optional[str] = None
    options: JobOptions = field(default_factory=JobOptions)


@dataclass
class DLQStats:
    total: int
    by_queue: dict[str, int] = field(default_factory=dict)


DLQCallback = Callable[[Job, str], Awaitable[None]]


class DLQManager:
    def __init__(
        self,
        max_retries: int = 3,
        queue_name: str = "dlq",
        on_dlq: Optional[DLQCallback] = None,
        adapter: Optional[FlowAdapter] = None,
    ):
        if max_retries < 1:
            raise ValueError("max_retries must be positive")
        self.max_retries = max_retries
        self.queue_name = queue_name
        self.on_dlq = on_dlq
        if adapter is None:
            from flowfn.adapters.memory import MemoryAdapter

            adapter = MemoryAdapter()
        self._adapter: FlowAdapter = adapter

    async def move_to_dlq(
        self, job: Job, reason: str, original_queue: Optional[str] = None
    ) -> DLQJob:
        record = DLQJob(
            id=job.id,
            name=job.name,
            data=deepcopy(job.data),
            original_queue=original_queue or self.queue_name,
            dlq_reason=reason,
            dlq_timestamp=self._now(),
            errors=job.stacktrace.copy(),
            attempts_made=job.attempts_made,
            failed_reason=job.failed_reason,
            options=job.opts.model_copy(deep=True),
        )
        await self._adapter.save_dead_letter(record)
        if self.on_dlq is not None:
            await self.on_dlq(job, reason)
        return record

    async def get_all(self) -> list[DLQJob]:
        return await self._adapter.get_dead_letters()

    async def get_by_queue(self, queue_name: str) -> list[DLQJob]:
        return [job for job in await self.get_all() if job.original_queue == queue_name]

    async def _resolve(self, job_id: str, original_queue: Optional[str]) -> DLQJob:
        matches = [
            job
            for job in await self.get_all()
            if job.id == job_id and (original_queue is None or job.original_queue == original_queue)
        ]
        if not matches:
            raise ValueError(f"Job not found in DLQ: {job_id}")
        if len(matches) != 1:
            raise ValueError("Job ID is ambiguous; provide original_queue")
        return matches[0]

    async def retry(self, job_id: str, original_queue: Optional[str] = None) -> Job:
        record = await self._resolve(job_id, original_queue)
        # Adapter atomically requeues and removes the dead letter only on success.
        return await self._adapter.retry_dead_letter(record.original_queue, record.id)

    async def retry_all(self, queue_name: str) -> int:
        jobs = await self.get_by_queue(queue_name)
        for job in jobs:
            await self.retry(job.id, queue_name)
        return len(jobs)

    async def delete(self, job_id: str, original_queue: Optional[str] = None) -> None:
        record = await self._resolve(job_id, original_queue)
        await self._adapter.delete_dead_letter(record.original_queue, record.id)

    async def clean(self, max_age: int) -> int:
        if max_age < 0:
            raise ValueError("max_age must be nonnegative")
        cutoff = self._now() - max_age
        old = [job for job in await self.get_all() if job.dlq_timestamp <= cutoff]
        for job in old:
            await self._adapter.delete_dead_letter(job.original_queue, job.id)
        return len(old)

    async def get_stats(self) -> DLQStats:
        jobs = await self.get_all()
        counts: dict[str, int] = {}
        for job in jobs:
            counts[job.original_queue] = counts.get(job.original_queue, 0) + 1
        return DLQStats(total=len(jobs), by_queue=counts)

    def _now(self) -> int:
        return int(time.time() * 1000)
