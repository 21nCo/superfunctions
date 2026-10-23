"""Core FlowFn implementation."""

from typing import Any, Optional, Protocol
from pydantic import BaseModel, Field


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
        self._adapter = None
        self._queues: dict[str, Any] = {}
        self._streams: dict[str, Any] = {}
        self._metrics = None
        self._scheduler = None
        self._health_checker = None
        self._event_tracker = None
        
        self._setup_adapter()
        self._setup_monitoring()
    
    def _setup_adapter(self) -> None:
        """Set up the adapter based on configuration."""
        if isinstance(self.config.adapter, str):
            if self.config.adapter == 'memory':
                from flowfn.adapters.memory import MemoryAdapter
                self._adapter = MemoryAdapter()
            else:
                raise ValueError(f"Unknown adapter: {self.config.adapter}")
        else:
            self._adapter = self.config.adapter
    
    def _setup_monitoring(self) -> None:
        """Set up monitoring components."""
        from flowfn.core.metrics import MetricsManager
        from flowfn.monitoring.health import HealthChecker, EventTracker
        
        self._metrics = MetricsManager(self._adapter)
        self._health_checker = HealthChecker()
        self._event_tracker = EventTracker()
    
    def queue(self, name: str, options: Optional[dict[str, Any]] = None) -> Any:
        """Get or create a queue."""
        if name not in self._queues:
            from flowfn.queue.queue import Queue
            
            queue_options = {**(self.config.default_queue_options or {}), **(options or {})}
            self._queues[name] = Queue(name, self._adapter, queue_options)
        
        return self._queues[name]
    
    async def list_queues(self) -> list[str]:
        """List all queue names."""
        return list(self._queues.keys())
    
    def stream(self, name: str, options: Optional[dict[str, Any]] = None) -> Any:
        """Get or create a stream."""
        if name not in self._streams:
            from flowfn.stream.stream import Stream
            
            stream_options = {**(self.config.default_stream_options or {}), **(options or {})}
            self._streams[name] = Stream(name, self._adapter, stream_options)
        
        return self._streams[name]
    
    async def list_streams(self) -> list[str]:
        """List all stream names."""
        return list(self._streams.keys())
    
    def workflow(self, name: str) -> Any:
        """Create a workflow builder."""
        from flowfn.workflow.builder import WorkflowBuilder
        return WorkflowBuilder(name, self._adapter)
    
    async def list_workflows(self) -> list[Any]:
        """List all workflows."""
        return []
    
    def scheduler(self) -> Any:
        """Get scheduler instance."""
        return self._scheduler
    
    @property
    def metrics(self) -> Any:
        """Get metrics manager."""
        return self._metrics
    
    async def health_check(self) -> dict[str, Any]:
        """Perform health check."""
        if self._health_checker:
            return await self._health_checker.check()
        return {"healthy": True, "timestamp": 0, "checks": []}
    
    def get_event_tracker(self) -> Any:
        """Get event tracker."""
        return self._event_tracker
    
    async def close(self) -> None:
        """Close all connections and cleanup."""
        if self._adapter:
            await self._adapter.cleanup()
        
        # Close all queues
        for queue in self._queues.values():
            await queue.close()
        
        # Close all streams
        for stream in self._streams.values():
            await stream.close()


def create_flow(
    adapter: Any = 'memory',
    **kwargs: Any
) -> FlowFn:
    """Create a FlowFn instance with simplified configuration."""
    config = FlowFnConfig(adapter=adapter, **kwargs)
    return FlowFn(config)
