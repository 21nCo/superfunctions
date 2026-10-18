"""Base adapter protocol."""

import asyncio
from typing import Any, Protocol, Optional, TYPE_CHECKING
from flowfn.queue.types import Job, JobStatus, QueueStats
from flowfn.stream.types import Message, StreamInfo, ConsumerOptions, TrimStrategy


if TYPE_CHECKING:
    from flowfn.queue.dlq import DLQJob
    from flowfn.workflow.types import WorkflowExecution


class FlowAdapter(Protocol):
    """Base protocol for FlowFn adapters."""

    async def health_probe(self) -> dict[str, Any]:
        """Return connected/type/server_time (epoch ms) from the storage clock."""
        ...

    # Queue operations
    def lease_loss_event(self, queue: str, job: Job) -> Optional[asyncio.Event]:
        """Return a signal for cooperative cancellation, or None for unleased storage."""
        ...

    async def release_job_lease(self, queue: str, job: Job) -> None:
        """Release local claim monitoring after a handler finishes."""
        ...

    async def enqueue(self, queue: str, job: Job) -> Job:
        """Add a job to the queue."""
        ...

    async def update_job(self, queue: str, job: Job) -> None:
        """Persist a transition, atomically recording a dead letter for FAILED jobs."""
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

    async def save_dead_letter(self, record: "DLQJob") -> None: ...

    async def get_dead_letters(self) -> list["DLQJob"]: ...

    async def delete_dead_letter(self, queue: str, job_id: str) -> None: ...

    async def retry_dead_letter(self, queue: str, job_id: str) -> Job:
        """Atomically restore a job and delete its dead letter."""
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
        handler: Any,
        options: Optional[ConsumerOptions] = None,
    ) -> Any:
        """Consume from stream with consumer group."""
        ...

    async def get_stream_info(self, stream: str) -> StreamInfo:
        """Get stream information."""
        ...

    async def get_stream_messages(self, stream: str) -> list[Message]:
        """Read retained stream messages in publication order."""
        ...

    async def trim_stream(self, stream: str, strategy: TrimStrategy) -> int:
        """Remove retained messages according to the supplied limits."""
        ...

    # Workflow operations
    async def save_workflow_state(self, execution_id: str, execution: "WorkflowExecution") -> None:
        """Save workflow execution state."""
        ...

    async def load_workflow_state(self, execution_id: str) -> Optional["WorkflowExecution"]:
        """Load workflow execution state."""
        ...

    async def transition_workflow_state(self, execution_id: str, operation: str, payload: dict[str, Any]) -> Optional["WorkflowExecution"]:
        """Atomically transition ownership; cancel_owned requires a matching unexpired token."""
        ...

    async def list_workflow_states(self, workflow_id: str) -> list["WorkflowExecution"]:
        """List persisted executions for one workflow definition."""
        ...

    # Lifecycle
    async def cleanup(self) -> None:
        """Cleanup adapter resources."""
        ...
