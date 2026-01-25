"""Dead-Letter Queue implementation."""

from typing import Any, Optional, Callable, Awaitable
from flowfn.queue.types import Job, JobStatus
from dataclasses import dataclass, field
import time


@dataclass
class DLQJob:
    """Job in dead-letter queue."""
    id: str
    name: str
    data: Any
    original_queue: str
    dlq_reason: str
    dlq_timestamp: int
    errors: list[str] = field(default_factory=list)
    attempts_made: int = 0
    failed_reason: Optional[str] = None


@dataclass
class DLQStats:
    """DLQ statistics."""
    total: int
    by_queue: dict[str, int] = field(default_factory=dict)


DLQCallback = Callable[[Job, str], Awaitable[None]]


class DLQManager:
    """Dead-letter queue manager."""
    
    def __init__(
        self,
        max_retries: int = 3,
        queue_name: str = 'dlq',
        on_dlq: Optional[DLQCallback] = None
    ):
        self.max_retries = max_retries
        self.queue_name = queue_name
        self.on_dlq = on_dlq
        self._jobs: dict[str, DLQJob] = {}
    
    async def move_to_dlq(self, job: Job, reason: str) -> DLQJob:
        """Move a job to the DLQ."""
        dlq_job = DLQJob(
            id=job.id,
            name=job.name,
            data=job.data,
            original_queue=job.name,
            dlq_reason=reason,
            dlq_timestamp=self._now(),
            errors=job.stacktrace.copy(),
            attempts_made=job.attempts_made,
            failed_reason=job.failed_reason
        )
        
        self._jobs[job.id] = dlq_job
        
        # Call callback if provided
        if self.on_dlq:
            await self.on_dlq(job, reason)
        
        return dlq_job
    
    async def get_all(self) -> list[DLQJob]:
        """Get all DLQ jobs."""
        return list(self._jobs.values())
    
    async def get_by_queue(self, queue_name: str) -> list[DLQJob]:
        """Get DLQ jobs by original queue."""
        return [
            job for job in self._jobs.values()
            if job.original_queue == queue_name
        ]
    
    async def retry(self, job_id: str) -> Job:
        """Retry a DLQ job."""
        if job_id not in self._jobs:
            raise ValueError(f"Job not found in DLQ: {job_id}")
        
        dlq_job = self._jobs[job_id]
        
        # Convert back to regular job
        job = Job(
            id=dlq_job.id,
            name=dlq_job.name,
            data=dlq_job.data,
            timestamp=self._now()
        )
        job.state = JobStatus.WAITING
        job.attempts_made = 0
        job.failed_reason = None
        job.stacktrace = []
        
        # Remove from DLQ
        del self._jobs[job_id]
        
        return job
    
    async def retry_all(self, queue_name: str) -> int:
        """Retry all jobs from a queue."""
        jobs = await self.get_by_queue(queue_name)
        count = 0
        
        for dlq_job in jobs:
            try:
                await self.retry(dlq_job.id)
                count += 1
            except Exception:
                pass
        
        return count
    
    async def delete(self, job_id: str) -> None:
        """Delete a job from DLQ."""
        self._jobs.pop(job_id, None)
    
    async def clean(self, max_age: int) -> int:
        """Clean old DLQ jobs."""
        now = self._now()
        to_delete = []
        
        for job_id, job in self._jobs.items():
            if now - job.dlq_timestamp > max_age:
                to_delete.append(job_id)
        
        for job_id in to_delete:
            del self._jobs[job_id]
        
        return len(to_delete)
    
    async def get_stats(self) -> DLQStats:
        """Get DLQ statistics."""
        by_queue: dict[str, int] = {}
        
        for job in self._jobs.values():
            queue = job.original_queue
            by_queue[queue] = by_queue.get(queue, 0) + 1
        
        return DLQStats(
            total=len(self._jobs),
            by_queue=by_queue
        )
    
    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)
