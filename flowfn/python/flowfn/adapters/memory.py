"""Memory adapter implementation."""

from typing import Any, Optional
from flowfn.queue.types import Job, JobStatus, QueueStats
from flowfn.stream.types import Message, StreamInfo, MessageHandler
import asyncio
from collections import defaultdict


class MemoryAdapter:
    """In-memory adapter for development and testing."""
    
    def __init__(self) -> None:
        self._queues: dict[str, list[Job]] = defaultdict(list)
        self._active_jobs: dict[str, Job] = {}
        self._streams: dict[str, list[Message]] = defaultdict(list)
        self._stream_subscribers: dict[str, list[MessageHandler]] = defaultdict(list)
        self._workflow_states: dict[str, Any] = {}
    
    # Queue operations
    async def enqueue(self, queue: str, job: Job) -> None:
        """Add job to queue."""
        self._queues[queue].append(job)
    
    async def dequeue(self, queue: str) -> Optional[Job]:
        """Get next job from queue."""
        jobs = self._queues.get(queue, [])
        
        # Get highest priority waiting job
        waiting_jobs = [j for j in jobs if j.state == JobStatus.WAITING]
        if not waiting_jobs:
            return None
        
        # Sort by priority (lower number = higher priority)
        waiting_jobs.sort(key=lambda j: j.opts.priority)
        job = waiting_jobs[0]
        
        # Mark as active
        job.state = JobStatus.ACTIVE
        self._active_jobs[job.id] = job
        
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
    
    # Stream operations
    async def publish(self, stream: str, message: Message) -> str:
        """Publish message to stream."""
        self._streams[stream].append(message)
        
        # Notify subscribers
        for handler in self._stream_subscribers.get(stream, []):
            asyncio.create_task(handler(message))
        
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
        handler: MessageHandler
    ) -> Any:
        """Consume from stream with consumer group."""
        return await self.subscribe(stream, handler)
    
    async def get_stream_info(self, stream: str) -> StreamInfo:
        """Get stream information."""
        messages = self._streams.get(stream, [])
        return StreamInfo(
            name=stream,
            length=len(messages),
            groups=0
        )
    
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
        self._queues.clear()
        self._active_jobs.clear()
        self._streams.clear()
        self._stream_subscribers.clear()
        self._workflow_states.clear()
