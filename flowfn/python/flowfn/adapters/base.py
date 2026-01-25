"""Base adapter protocol."""

from typing import Any, Protocol, Optional
from flowfn.queue.types import Job, JobStatus, QueueStats
from flowfn.stream.types import Message, StreamInfo


class FlowAdapter(Protocol):
    """Base protocol for FlowFn adapters."""
    
    # Queue operations
    async def enqueue(self, queue: str, job: Job) -> None:
        """Add a job to the queue."""
        ...
    
    async def dequeue(self, queue: str) -> Optional[Job]:
        """Get next job from queue."""
        ...
    
    async def get_queue_stats(self, queue: str) -> QueueStats:
        """Get queue statistics."""
        ...
    
    async def get_jobs(self, queue: str, status: JobStatus) -> list[Job]:
        """Get jobs by status."""
        ...
    
    async def get_all_jobs(self, queue: str) -> list[Job]:
        """Get all jobs in queue."""
        ...
    
    async def clean_jobs(self, queue: str, grace: int, status: JobStatus) -> int:
        """Clean old jobs."""
        ...
    
    # Stream operations
    async def publish(self, stream: str, message: Message) -> str:
        """Publish message to stream."""
        ...
    
    async def subscribe(self, stream: str, handler: Any) -> Any:
        """Subscribe to stream."""
        ...
    
    async def consume(
        self,
        stream: str,
        group: str,
        consumer: str,
        handler: Any
    ) -> Any:
        """Consume from stream with consumer group."""
        ...
    
    async def get_stream_info(self, stream: str) -> StreamInfo:
        """Get stream information."""
        ...
    
    # Workflow operations
    async def save_workflow_state(self, execution_id: str, execution: Any) -> None:
        """Save workflow execution state."""
        ...
    
    async def load_workflow_state(self, execution_id: str) -> Optional[Any]:
        """Load workflow execution state."""
        ...
    
    # Lifecycle
    async def cleanup(self) -> None:
        """Cleanup adapter resources."""
        ...
