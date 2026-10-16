"""Memory adapter implementation."""

from typing import Any, Optional
from flowfn.queue.types import Job, JobStatus, QueueStats
from flowfn.stream.types import Message, StreamInfo, MessageHandler, ConsumerOptions, TrimStrategy
from flowfn.adapters.memory_stream import MemoryConsumerGroup
import asyncio
import time
import hashlib
import json
from copy import deepcopy
from collections import defaultdict


class MemoryAdapter:
    """In-memory adapter for development and testing."""

    def __init__(self) -> None:
        self._queues: dict[str, list[Job]] = defaultdict(list)
        self._dead_letters: dict[tuple[str, str], Any] = {}
        self._dependency_results: dict[tuple[str, str], JobStatus] = {}
        self._active_jobs: dict[tuple[str, str], Job] = {}
        self._streams: dict[str, list[Message]] = defaultdict(list)
        self._stream_subscribers: dict[str, list[MessageHandler]] = defaultdict(list)
        self._workflow_states: dict[str, Any] = {}
        self._groups: dict[tuple[str, str], MemoryConsumerGroup] = {}
        self._deliveries: set[asyncio.Task[None]] = set()

    # Queue operations
    async def enqueue(self, queue: str, job: Job) -> Job:
        """Atomically deduplicate and validate the dependency graph."""
        jobs = self._queues[queue]
        if job.opts.prevent_duplicates and job.opts.deduplication_key is None:
            payload = json.dumps(
                [job.name, job.data], sort_keys=True, separators=(",", ":"), allow_nan=False
            )
            job.opts.deduplication_key = hashlib.sha256(payload.encode()).hexdigest()
        for existing in jobs:
            if existing.id == job.id:
                return existing
            if (
                job.opts.prevent_duplicates
                and existing.opts.deduplication_key == job.opts.deduplication_key
                and existing.state not in (JobStatus.COMPLETED, JobStatus.FAILED)
            ):
                return existing
        graph = {entry.id: entry.opts.wait_for or [] for entry in [*jobs, job]}
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(identity: str) -> None:
            if identity in visiting:
                raise ValueError("Job dependencies contain a cycle")
            if identity in visited:
                return
            visiting.add(identity)
            for dependency in graph.get(identity, []):
                visit(dependency)
            visiting.remove(identity)
            visited.add(identity)

        visit(job.id)
        jobs.append(job)
        return job

    async def update_job(self, queue: str, job: Job) -> None:
        for index, stored in enumerate(self._queues.get(queue, [])):
            if stored.id == job.id:
                self._queues[queue][index] = job
                if job.state != JobStatus.ACTIVE:
                    self._active_jobs.pop((queue, job.id), None)
                self._apply_retention(queue, job)
                return
        raise ValueError(f"Job not found: {job.id}")

    def _apply_retention(self, queue: str, changed: Job) -> None:
        jobs = self._queues[queue]
        status = changed.state
        policy = (
            changed.opts.remove_on_complete
            if status == JobStatus.COMPLETED
            else changed.opts.remove_on_fail
            if status == JobStatus.FAILED
            else False
        )
        removed: list[Job] = []
        if policy is True:
            removed = [changed]
        elif type(policy) is int:
            terminal = [job for job in jobs if job.state == status]
            positions = {id(job): index for index, job in enumerate(jobs)}
            terminal.sort(key=lambda job: (job.finished_on or 0, positions[id(job)]), reverse=True)
            removed = terminal[max(0, policy) :]
        for job in removed:
            self._dependency_results[(queue, job.id)] = job.state
            jobs.remove(job)
        referenced = {
            identity
            for job in jobs
            if job.state not in (JobStatus.COMPLETED, JobStatus.FAILED)
            for identity in job.opts.wait_for or []
        }
        for key in list(self._dependency_results):
            if key[0] == queue and key[1] not in referenced:
                del self._dependency_results[key]

    def _now(self) -> int:
        return int(time.time() * 1000)

    async def dequeue(self, queue: str) -> Optional[Job]:
        """Get next job from queue."""
        jobs = self._queues.get(queue, [])

        now = self._now()
        for candidate in jobs:
            due = (
                candidate.available_at
                if candidate.available_at is not None
                else candidate.timestamp + candidate.delay
            )
            if candidate.state == JobStatus.DELAYED and due <= now:
                candidate.state = JobStatus.WAITING

        indexed = {job.id: job for job in jobs}

        def dependency_status(identity: str) -> Optional[JobStatus]:
            return (
                indexed[identity].state
                if identity in indexed
                else self._dependency_results.get((queue, identity))
            )

        # Propagate terminal dependency failure before choosing runnable work.
        dependency_failures: list[Job] = []
        changed = True
        while changed:
            changed = False
            for candidate in jobs:
                if candidate.state not in (JobStatus.WAITING, JobStatus.DELAYED):
                    continue
                failed = next(
                    (
                        identity
                        for identity in candidate.opts.wait_for or []
                        if dependency_status(identity) == JobStatus.FAILED
                    ),
                    None,
                )
                if failed is not None:
                    candidate.state = JobStatus.FAILED
                    candidate.failed_reason = f"Dependency failed: {failed}"
                    candidate.finished_on = now
                    dependency_failures.append(candidate)
                    changed = True

        if dependency_failures:
            from flowfn.queue.dlq import DLQManager

            for failed_job in dependency_failures:
                await DLQManager(adapter=self).move_to_dlq(
                    failed_job, failed_job.failed_reason or "Dependency failed", queue
                )
                if failed_job in jobs:
                    await self.update_job(queue, failed_job)

        # Get highest priority waiting job
        waiting_jobs = [
            j
            for j in jobs
            if j.state == JobStatus.WAITING
            and (j.available_at if j.available_at is not None else j.timestamp + j.delay) <= now
            and all(
                dependency_status(identity) == JobStatus.COMPLETED
                for identity in j.opts.wait_for or []
            )
        ]
        if not waiting_jobs:
            return None

        # Sort by priority (lower number = higher priority)
        waiting_jobs.sort(key=lambda j: j.opts.priority)
        job = waiting_jobs[0]

        # Mark as active
        job.state = JobStatus.ACTIVE
        self._active_jobs[(queue, job.id)] = job

        return job

    async def get_queue_stats(self, queue: str) -> QueueStats:
        """Get queue statistics."""
        jobs = self._queues.get(queue, [])

        stats = QueueStats()
        for job in jobs:
            if job.state == JobStatus.WAITING:
                stats.waiting += 1
            elif job.state == JobStatus.ACTIVE:
                stats.active += 1
            elif job.state == JobStatus.COMPLETED:
                stats.completed += 1
            elif job.state == JobStatus.FAILED:
                stats.failed += 1
            elif job.state == JobStatus.DELAYED:
                stats.delayed += 1
            elif job.state == JobStatus.PAUSED:
                stats.paused += 1

        return stats

    async def get_jobs(self, queue: str, status: JobStatus) -> list[Job]:
        """Get jobs by status."""
        jobs = self._queues.get(queue, [])
        return [j for j in jobs if j.state == status]

    async def get_all_jobs(self, queue: str) -> list[Job]:
        """Get all jobs."""
        return self._queues.get(queue, []).copy()

    async def clean_jobs(self, queue: str, grace: int, status: JobStatus) -> int:
        """Clean old jobs."""
        import time

        now = int(time.time() * 1000)

        jobs = self._queues.get(queue, [])
        to_remove = []

        for job in jobs:
            if job.state == status:
                finished_time = job.finished_on or job.timestamp
                if now - finished_time > grace:
                    to_remove.append(job)

        for job in to_remove:
            jobs.remove(job)

        return len(to_remove)

    async def save_dead_letter(self, record: Any) -> None:
        self._dead_letters[(record.original_queue, record.id)] = deepcopy(record)

    async def get_dead_letters(self) -> list[Any]:
        return deepcopy(list(self._dead_letters.values()))

    async def delete_dead_letter(self, queue: str, job_id: str) -> None:
        self._dead_letters.pop((queue, job_id), None)

    async def retry_dead_letter(self, queue: str, job_id: str) -> Job:
        key = (queue, job_id)
        record = self._dead_letters.get(key)
        if record is None:
            raise ValueError("Dead letter no longer exists")
        jobs = self._queues[queue]
        existing = next((job for job in jobs if job.id == job_id), None)
        if existing is not None and existing.state not in (JobStatus.FAILED, JobStatus.COMPLETED):
            raise ValueError("Job is already queued or active")
        job = Job(
            id=record.id,
            name=record.name,
            data=deepcopy(record.data),
            opts=record.options.model_copy(deep=True),
            timestamp=self._now(),
            available_at=self._now(),
        )
        if existing is None:
            jobs.append(job)
        else:
            jobs[jobs.index(existing)] = job
        del self._dead_letters[key]
        return job

    # Stream operations
    async def publish(self, stream: str, message: Message) -> str:
        """Publish message to stream."""
        self._streams[stream].append(message)

        # Notify subscribers
        for handler in self._stream_subscribers.get(stream, []):

            async def deliver(
                callback: MessageHandler = handler, payload: Message = message.model_copy(deep=True)
            ) -> None:
                await callback(payload)

            task = asyncio.create_task(deliver())
            self._deliveries.add(task)

            def finished(done: asyncio.Task[None]) -> None:
                self._deliveries.discard(done)
                if not done.cancelled() and done.exception() is not None:
                    done.get_loop().call_exception_handler(
                        {"message": "Stream subscriber failed", "exception": done.exception()}
                    )

            task.add_done_callback(finished)
        for (name, _), group in self._groups.items():
            if name == stream:
                group.publish(message)

        return message.id

    async def subscribe(self, stream: str, handler: MessageHandler) -> Any:
        """Subscribe to stream."""
        self._stream_subscribers[stream].append(handler)

        class Subscription:
            async def unsubscribe(self_sub: Any) -> None:
                if handler in self._stream_subscribers[stream]:
                    self._stream_subscribers[stream].remove(handler)

        return Subscription()

    async def consume(
        self,
        stream: str,
        group: str,
        consumer: str,
        handler: MessageHandler,
        options: Optional[ConsumerOptions] = None,
    ) -> Any:
        """Deliver each message to one member of each consumer group."""
        opts = options or ConsumerOptions(group_id=group)
        key = (stream, group)
        if key not in self._groups:
            self._groups[key] = MemoryConsumerGroup(
                self._streams[stream] if opts.from_beginning else []
            )
        return self._groups[key].subscribe(consumer, handler, opts)

    async def get_stream_info(self, stream: str) -> StreamInfo:
        """Get stream information."""
        messages = self._streams.get(stream, [])
        return StreamInfo(
            name=stream,
            length=len(messages),
            groups=sum(name == stream for name, _ in self._groups),
        )

    async def get_stream_messages(self, stream: str) -> list[Message]:
        return [message.model_copy(deep=True) for message in self._streams.get(stream, [])]

    async def trim_stream(self, stream: str, strategy: TrimStrategy) -> int:
        messages = self._streams.get(stream, [])
        retained = messages
        if strategy.max_age_seconds is not None:
            cutoff = self._now() - strategy.max_age_seconds * 1000
            retained = [message for message in retained if message.timestamp >= cutoff]
        if strategy.max_length is not None:
            retained = retained[-strategy.max_length :] if strategy.max_length else []
        self._streams[stream] = retained
        return len(messages) - len(retained)

    # Workflow operations
    async def save_workflow_state(self, execution_id: str, execution: Any) -> None:
        """Save workflow state."""
        self._workflow_states[execution_id] = execution

    async def load_workflow_state(self, execution_id: str) -> Optional[Any]:
        """Load workflow state."""
        return self._workflow_states.get(execution_id)

    # Lifecycle
    async def cleanup(self) -> None:
        """Cleanup resources."""
        await asyncio.gather(*(group.close() for group in self._groups.values()))
        self._groups.clear()
        tasks = list(self._deliveries)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._deliveries.clear()
        self._dependency_results.clear()
        self._dead_letters.clear()
        self._queues.clear()
        self._active_jobs.clear()
        self._streams.clear()
        self._stream_subscribers.clear()
        self._workflow_states.clear()
