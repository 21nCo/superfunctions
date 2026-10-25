"""Core FlowFn implementation."""

import asyncio
import math
from typing import TYPE_CHECKING, Any, Callable, Optional, Union, cast

from pydantic import BaseModel

from flowfn.adapters.base import FlowAdapter
from flowfn.core.metrics import MetricsManager
from flowfn.core.telemetry import ObservedAdapter, OperationObserver
from flowfn.monitoring.health import EventTracker, HealthChecker
from flowfn.scheduler import Scheduler

if TYPE_CHECKING:
    from flowfn.queue.dlq import DLQManager
    from flowfn.queue.queue import Queue
    from flowfn.stream.stream import Stream
    from flowfn.workflow.builder import WorkflowBuilder
    from flowfn.workflow.workflow import Workflow


class FlowFnConfig(BaseModel):
    """Configuration for FlowFn instance."""

    adapter: Any  # FlowAdapter | string
    namespace: Optional[str] = None
    default_job_options: Optional[dict[str, Any]] = None
    default_queue_options: Optional[dict[str, Any]] = None
    default_stream_options: Optional[dict[str, Any]] = None
    telemetry: Optional[dict[str, Any]] = None
    on_error: Optional[Any] = None


class FlowFn:
    """Main FlowFn class for managing queues, streams, and workflows."""

    def __init__(self, config: FlowFnConfig):
        """Initialize FlowFn with configuration."""
        self.config = config
        self._closing = False
        self._close_task: Optional[asyncio.Task[None]] = None
        self._adapter: FlowAdapter
        self._queues: dict[str, Queue] = {}
        self._streams: dict[str, Stream] = {}
        self._workflows: list[Workflow] = []
        self._metrics: MetricsManager
        self._health_checker: HealthChecker
        self._event_tracker: EventTracker

        self._observer = OperationObserver(config.telemetry, config.on_error)
        self._setup_adapter()
        if self._observer.tracer is not None or config.on_error is not None:
            self._adapter = cast(FlowAdapter, ObservedAdapter(self._adapter, self._observer))
        self._scheduler = Scheduler(self._adapter)
        self._setup_monitoring()

    def _setup_adapter(self) -> None:
        """Set up the adapter based on configuration."""
        if isinstance(self.config.adapter, str):
            if self.config.adapter == "memory":
                from flowfn.adapters.memory import MemoryAdapter

                self._adapter = MemoryAdapter()
            else:
                raise ValueError(f"Unknown adapter: {self.config.adapter}")
        else:
            self._adapter = self.config.adapter

    def _setup_monitoring(self) -> None:
        """Set up monitoring components."""
        from flowfn.core.metrics import MetricsManager
        from flowfn.monitoring.health import EventTracker, HealthChecker

        self._metrics = MetricsManager(self._adapter,lambda: {
            "queues":len(self._queues),"streams":len(self._streams),"workflows":len(self._workflows),
            "workers":sum(not task.done() for queue in self._queues.values() for task in queue._workers),
        })
        self._health_checker = HealthChecker()
        self._event_tracker = EventTracker(self._observer)

    def queue(self, name: str, options: Optional[dict[str, Any]] = None) -> "Queue":
        """Get or create a queue."""
        self._require_open()
        if name not in self._queues:
            from flowfn.queue.queue import Queue

            queue_options = {
                "default_job_options": self.config.default_job_options or {},
                **(self.config.default_queue_options or {}),
                **(options or {}),
            }
            self._queues[name] = Queue(name, self._adapter, queue_options, metrics=self._metrics, observer=self._observer, events=self._event_tracker)

        return self._queues[name]

    async def list_queues(self) -> list[str]:
        """List all queue names."""
        return list(self._queues.keys())

    def stream(self, name: str, options: Optional[dict[str, Any]] = None) -> "Stream":
        """Get or create a stream."""
        self._require_open()
        if name not in self._streams:
            from flowfn.stream.stream import Stream

            stream_options = {**(self.config.default_stream_options or {}), **(options or {})}
            self._streams[name] = Stream(name, self._adapter, stream_options, metrics=self._metrics, observer=self._observer, events=self._event_tracker)

        elif options is not None and "partitions" in options:
            from flowfn.stream.types import StreamOptions

            requested = StreamOptions.model_validate(options).partitions
            if requested != self._streams[name].partitions:
                raise ValueError("Cached stream partition policy cannot change; use a new Flow instance")
        return self._streams[name]

    async def list_streams(self) -> list[str]:
        """List all stream names."""
        return list(self._streams.keys())

    def workflow(self, name: str) -> "WorkflowBuilder":
        """Create a workflow builder."""
        self._require_open()
        from flowfn.workflow.builder import WorkflowBuilder

        return WorkflowBuilder(name, self._adapter, self._register_workflow)

    async def list_workflows(self) -> list["Workflow"]:
        """List all workflows."""
        return list(self._workflows)

    def dlq(self) -> "DLQManager":
        """Inspect and retry failed jobs through the same adapter."""
        self._require_open()
        from flowfn.queue.dlq import DLQManager

        return DLQManager(adapter=self._adapter)

    def scheduler(self) -> Scheduler:
        """Get scheduler instance."""
        self._require_open()
        return self._scheduler

    @property
    def metrics(self) -> MetricsManager:
        """Get metrics manager."""
        return self._metrics

    async def health_check(self, timeout: float = 5.0) -> dict[str, Any]:
        """Probe storage and registered resources within a cooperative timeout."""
        from flowfn.monitoring.runtime import runtime_health
        return await runtime_health(self._adapter, self._queues, self._streams, self._workflows,
                                    self._health_checker, self._closing, timeout)

    def on(self, event_type: str, listener: Callable[[dict[str, Any]], Any]) -> Callable[[], None]:
        self._require_open()
        return self._event_tracker.on(event_type, listener)

    def off(self, event_type: str, listener: Callable[[dict[str, Any]], Any]) -> None:
        self._event_tracker.off(event_type, listener)

    def get_event_tracker(self) -> EventTracker:
        """Get event tracker."""
        return self._event_tracker

    def _require_open(self) -> None:
        if self._closing:
            raise RuntimeError('FlowFn is closed')

    def _register_workflow(self, workflow: "Workflow") -> None:
        self._require_open()
        workflow._observer = self._observer
        workflow._events = self._event_tracker
        self._workflows.append(workflow)

    async def close(self, timeout: float = 30.0) -> None:
        """Bound this wait while shared cleanup safely drains admitted work."""
        if not math.isfinite(timeout) or timeout < 0:
            raise ValueError('Shutdown timeout must be finite and nonnegative')
        if self._close_task is None:
            self._closing = True
            resources: list[Any] = [self._scheduler, *self._workflows, *self._queues.values(), *self._streams.values()]
            for resource in resources:
                resource._closed = True
            async def finish() -> None:
                results = await asyncio.gather(*(resource.close() for resource in resources),return_exceptions=True)
                failures = [item for item in results if isinstance(item,BaseException)]
                if failures:
                    raise RuntimeError('FlowFn resource shutdown failed') from failures[0]
                await self._adapter.cleanup()
            self._close_task = asyncio.create_task(finish())
            self._close_task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        done, _ = await asyncio.wait((self._close_task,),timeout=timeout)
        if not done:
            raise TimeoutError('FlowFn shutdown deadline exceeded; cleanup remains active')
        await asyncio.shield(self._close_task)


def create_flow(adapter: Union[str, FlowAdapter] = "memory", **kwargs: Any) -> FlowFn:
    """Create a FlowFn instance with simplified configuration."""
    config = FlowFnConfig(adapter=adapter, **kwargs)
    return FlowFn(config)
