"""Queue implementation."""

from typing import Any, Optional, Callable, Awaitable
from flowfn.queue.types import (
    Job,
    JobOptions,
    JobStatus,
    JobHandler,
    BatchHandler,
    BatchOptions,
    QueueStats,
    BackoffType,
)
from flowfn.adapters.base import FlowAdapter
import asyncio
import uuid
import time
import math


class Queue:
    """Queue for background job processing."""

    def __init__(self, name: str, adapter: FlowAdapter, options: Optional[dict[str, Any]] = None):
        self.name = name
        self._adapter = adapter
        self._options = options or {}
        self._processing = False
        self._paused = False
        self._closed = False
        self._workers: list[asyncio.Task[None]] = []

    async def add(self, name: str, data: Any, opts: Optional[JobOptions] = None) -> Job:
        """Add a job to the queue."""
        if self._closed:
            raise RuntimeError("Queue is closed")
        defaults = self._options.get("default_job_options", {})
        provided = opts.model_dump(exclude_unset=True) if opts is not None else {}
        if opts is not None and opts.backoff is not None:
            provided["backoff"] = opts.backoff
        job_options = JobOptions.model_validate({**defaults, **provided})
        if (
            job_options.backoff
            and job_options.backoff.type == BackoffType.CUSTOM
            and job_options.backoff.strategy is None
        ):
            raise ValueError("Custom backoff requires a strategy")

        job = Job(
            id=job_options.job_id or str(uuid.uuid4()),
            name=name,
            data=data,
            opts=job_options,
            timestamp=self._now(),
            delay=job_options.delay,
            available_at=self._now() + job_options.delay,
            state=JobStatus.DELAYED if job_options.delay else JobStatus.WAITING,
        )

        return await self._adapter.enqueue(self.name, job)

    async def add_bulk(self, jobs: list[dict[str, Any]]) -> list[Job]:
        """Add multiple jobs."""
        results = []
        for job_data in jobs:
            job = await self.add(job_data["name"], job_data["data"], job_data.get("opts"))
            results.append(job)
        return results

    def process(
        self, handler: Optional[JobHandler] = None, concurrency: int = 1
    ) -> Callable[[JobHandler], JobHandler]:
        """Start processing jobs."""

        def decorator(func: JobHandler) -> JobHandler:
            actual_handler = handler or func
            self._start_processing(actual_handler, concurrency)
            return func

        if handler:
            self._start_processing(handler, concurrency)
            return lambda f: f

        return decorator

    def _start_processing(self, handler: JobHandler, concurrency: int) -> None:
        """Start worker tasks."""
        if self._closed:
            raise RuntimeError("Queue is closed")
        if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 1:
            raise ValueError("Concurrency must be a positive integer")
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
                if self._paused:
                    await asyncio.sleep(0.01)
                    continue
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
            if job.opts.timeout is None:
                result = await handler(job)
            else:
                result = await asyncio.wait_for(handler(job), job.opts.timeout / 1000)

            # Mark as completed
            job.state = JobStatus.COMPLETED
            job.returnvalue = result
            job.finished_on = self._now()

        except asyncio.CancelledError:
            job.state = JobStatus.WAITING
            job.processed_on = None
            raise

        except Exception as error:
            job.attempts_made += 1
            job.failed_reason = str(error)
            job.stacktrace.append(str(error))

            # Check if should retry
            if job.attempts_made < job.opts.attempts:
                backoff = job.opts.backoff
                delay = 0
                if backoff:
                    delay = backoff.delay
                    if backoff.type == BackoffType.EXPONENTIAL:
                        delay *= 2 ** (job.attempts_made - 1)
                    if backoff.type == BackoffType.CUSTOM:
                        assert backoff.strategy is not None
                        try:
                            delay = backoff.strategy(job.attempts_made)
                        except Exception as backoff_error:
                            job.state = JobStatus.FAILED
                            job.finished_on = self._now()
                            job.failed_reason = f"Backoff strategy failed: {backoff_error}"
                            return
                        if (
                            isinstance(delay, bool)
                            or not isinstance(delay, (int, float))
                            or not math.isfinite(delay)
                            or delay < 0
                        ):
                            job.state = JobStatus.FAILED
                            job.finished_on = self._now()
                            job.failed_reason = (
                                "Backoff strategy must return a finite nonnegative delay"
                            )
                            return
                    if backoff.max_delay is not None:
                        delay = min(delay, backoff.max_delay)
                job.available_at = self._now() + delay
                job.state = JobStatus.DELAYED if delay else JobStatus.WAITING
            else:
                job.state = JobStatus.FAILED
                job.finished_on = self._now()
        finally:
            await self._adapter.update_job(self.name, job)

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
        self._paused = True

    async def resume(self) -> None:
        """Resume queue processing."""
        if self._closed:
            raise RuntimeError("Queue is closed")
        self._paused = False

    async def drain(self) -> None:
        """Wait for all jobs to complete."""
        while True:
            stats = await self.get_job_counts()
            if stats.waiting == 0 and stats.active == 0 and stats.delayed == 0:
                break
            await asyncio.sleep(0.1)

    async def close(self) -> None:
        """Close the queue."""
        self._closed = True
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
