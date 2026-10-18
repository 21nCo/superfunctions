"""Queue implementation."""

from typing import Any, Optional, Callable, Awaitable
from flowfn.queue.types import (
    Job,
    JobLeaseError,
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
from flowfn.core.lifecycle import Admissions
from flowfn.core.metrics import MetricsManager
import uuid
import time
import math


class Queue:
    """Queue for background job processing."""

    def __init__(self, name: str, adapter: FlowAdapter, options: Optional[dict[str, Any]] = None, *, metrics: Optional[MetricsManager] = None):
        self.name = name
        self._metrics = metrics
        self._adapter = adapter
        self._options = options or {}
        self._processing = False
        self._paused = False
        self._closed = False
        self._admissions = Admissions(lambda: self._closed)
        self._workers: list[asyncio.Task[None]] = []

    async def add(self, name: str, data: Any, opts: Optional[JobOptions] = None) -> Job:
        """Add a job to the queue."""
        async with self._admissions.track():
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
        while self._processing and not self._closed:
            try:
                if self._paused:
                    await asyncio.sleep(0.01)
                    continue
                job = await self._adapter.dequeue(self.name)

                if not job:
                    await asyncio.sleep(0.1)
                    continue

                await self._process_job(job, handler)

            except JobLeaseError:
                continue
            except Exception as e:
                print(f"Worker error: {e}")
                await asyncio.sleep(1)

    async def _invoke_handler(self, job: Job, handler: JobHandler, lost: Optional[asyncio.Event]) -> Any:
        if lost is None:
            return await handler(job)
        if lost.is_set():
            raise JobLeaseError('Job ownership lost before processing')
        task = asyncio.ensure_future(handler(job))
        guard = asyncio.create_task(lost.wait())
        try:
            await asyncio.wait({task,guard},return_when=asyncio.FIRST_COMPLETED)
            if lost.is_set():
                raise JobLeaseError('Job ownership lost while processing')
            return task.result()
        finally:
            for pending in (task,guard):
                if not pending.done():
                    pending.cancel()
            await asyncio.gather(task,guard,return_exceptions=True)

    async def _process_job(self, job: Job, handler: JobHandler) -> None:
        """Process a single job."""
        job.processed_on = self._now()
        lost = self._adapter.lease_loss_event(self.name,job)
        ownership_lost = False

        try:
            # Execute handler
            if job.opts.timeout is None:
                result = await self._invoke_handler(job,handler,lost)
            else:
                result = await asyncio.wait_for(self._invoke_handler(job,handler,lost), job.opts.timeout / 1000)

            # Mark as completed
            job.state = JobStatus.COMPLETED
            job.returnvalue = result
            job.finished_on = self._now()

        except JobLeaseError:
            ownership_lost = True
            raise

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
            try:
                if not ownership_lost and not (lost is not None and lost.is_set()):
                    await self._adapter.update_job(self.name, job)
                    if self._metrics is not None and job.state in (JobStatus.COMPLETED,JobStatus.FAILED):
                        if job.state == JobStatus.COMPLETED:
                            self._metrics.increment('queue.throughput',{'queue':self.name})
                        if job.processed_on is not None and job.finished_on is not None:
                            self._metrics.record('queue.job.duration',max(0,job.finished_on-job.processed_on),{'queue':self.name})
            finally:
                await self._adapter.release_job_lease(self.name,job)

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
        await self._admissions.drain()

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
