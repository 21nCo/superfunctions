"""Queue implementation."""

from typing import Any, Optional, Callable, Awaitable
from flowfn.queue.types import (
    Job,
    JobOptions,
    JobStatus,
    JobHandler,
    BatchHandler,
    BatchOptions,
    QueueStats
)
from flowfn.adapters.base import FlowAdapter
import asyncio
import uuid
import time


class Queue:
    """Queue for background job processing."""
    
    def __init__(
        self,
        name: str,
        adapter: FlowAdapter,
        options: Optional[dict[str, Any]] = None
    ):
        self.name = name
        self._adapter = adapter
        self._options = options or {}
        self._processing = False
        self._workers: list[asyncio.Task[None]] = []
    
    async def add(
        self,
        name: str,
        data: Any,
        opts: Optional[JobOptions] = None
    ) -> Job:
        """Add a job to the queue."""
        job_options = opts or JobOptions()
        
        job = Job(
            id=job_options.job_id or str(uuid.uuid4()),
            name=name,
            data=data,
            opts=job_options,
            timestamp=self._now(),
            delay=job_options.delay
        )
        
        await self._adapter.enqueue(self.name, job)
        return job
    
    async def add_bulk(
        self,
        jobs: list[dict[str, Any]]
    ) -> list[Job]:
        """Add multiple jobs."""
        results = []
        for job_data in jobs:
            job = await self.add(
                job_data['name'],
                job_data['data'],
                job_data.get('opts')
            )
            results.append(job)
        return results
    
    def process(
        self,
        handler: Optional[JobHandler] = None,
        concurrency: int = 1
    ) -> Callable[[JobHandler], None]:
        """Start processing jobs."""
        def decorator(func: JobHandler) -> None:
            actual_handler = handler or func
            self._start_processing(actual_handler, concurrency)
            return None
        
        if handler:
            self._start_processing(handler, concurrency)
            return lambda f: None
        
        return decorator
    
    def _start_processing(
        self,
        handler: JobHandler,
        concurrency: int
    ) -> None:
        """Start worker tasks."""
        if self._processing:
            return
        
        self._processing = True
        
        for _ in range(concurrency):
            task = asyncio.create_task(self._worker(handler))
            self._workers.append(task)
    
    async def _worker(self, handler: JobHandler) -> None:
        """Worker coroutine."""
        while self._processing:
            try:
                job = await self._adapter.dequeue(self.name)
                
                if not job:
                    await asyncio.sleep(0.1)
                    continue
                
                await self._process_job(job, handler)
            
            except Exception as e:
                print(f"Worker error: {e}")
                await asyncio.sleep(1)
    
    async def _process_job(self, job: Job, handler: JobHandler) -> None:
        """Process a single job."""
        job.processed_on = self._now()
        
        try:
            # Execute handler
            result = await handler(job)
            
            # Mark as completed
            job.state = JobStatus.COMPLETED
            job.returnvalue = result
            job.finished_on = self._now()
        
        except Exception as error:
            job.attempts_made += 1
            job.failed_reason = str(error)
            job.stacktrace.append(str(error))
            
            # Check if should retry
            if job.attempts_made < job.opts.attempts:
                job.state = JobStatus.WAITING
                # TODO: Apply backoff delay
            else:
                job.state = JobStatus.FAILED
                job.finished_on = self._now()
    
    async def get_job(self, job_id: str) -> Optional[Job]:
        """Get a specific job."""
        all_jobs = await self._adapter.get_all_jobs(self.name)
        for job in all_jobs:
            if job.id == job_id:
                return job
        return None
    
    async def get_jobs(self, status: JobStatus) -> list[Job]:
        """Get jobs by status."""
        return await self._adapter.get_jobs(self.name, status)
    
    async def get_job_counts(self) -> QueueStats:
        """Get job counts."""
        return await self._adapter.get_queue_stats(self.name)
    
    async def clean(self, grace: int, status: JobStatus) -> int:
        """Clean old jobs."""
        return await self._adapter.clean_jobs(self.name, grace, status)
    
    async def pause(self) -> None:
        """Pause queue processing."""
        self._processing = False
    
    async def resume(self) -> None:
        """Resume queue processing."""
        self._processing = True
    
    async def drain(self) -> None:
        """Wait for all jobs to complete."""
        while True:
            stats = await self.get_job_counts()
            if stats.waiting == 0 and stats.active == 0:
                break
            await asyncio.sleep(0.1)
    
    async def close(self) -> None:
        """Close the queue."""
        self._processing = False
        
        # Cancel all workers
        for task in self._workers:
            task.cancel()
        
        # Wait for workers to finish
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        
        self._workers.clear()
    
    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)
