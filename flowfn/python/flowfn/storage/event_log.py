"""Event log for event sourcing."""

from typing import Any, Optional, Protocol, Callable, Awaitable
from pydantic import BaseModel
from dataclasses import dataclass
import time


class Event(BaseModel):
    """Event model."""
    id: str
    aggregate_id: str
    aggregate_type: str
    type: str
    data: Any
    timestamp: int
    version: int
    
    class Config:
        arbitrary_types_allowed = True


@dataclass
class FilterOptions:
    """Event filter options."""
    aggregate_id: Optional[str] = None
    aggregate_type: Optional[str] = None
    event_type: Optional[str] = None
    since: Optional[int] = None
    limit: int = 100


EventHandler = Callable[[Event], Awaitable[None]]


class EventLog(Protocol):
    """Event log interface."""
    
    async def append(self, event: Event) -> None:
        """Append an event."""
        ...
    
    async def get_events(
        self,
        opts: Optional[FilterOptions] = None
    ) -> list[Event]:
        """Get events with filtering."""
        ...
    
    async def get_aggregate_events(
        self,
        aggregate_id: str
    ) -> list[Event]:
        """Get all events for an aggregate."""
        ...
    
    async def subscribe(self, handler: EventHandler) -> Any:
        """Subscribe to new events."""
        ...


class MemoryEventLog:
    """In-memory event log."""
    
    def __init__(self) -> None:
        self._events: list[Event] = []
        self._by_aggregate: dict[str, list[Event]] = {}
        self._subscribers: list[EventHandler] = []
        self._version_map: dict[str, int] = {}
    
    async def append(self, event: Event) -> None:
        """Append an event."""
        # Set version
        aggregate_key = f"{event.aggregate_type}:{event.aggregate_id}"
        version = self._version_map.get(aggregate_key, 0) + 1
        event.version = version
        self._version_map[aggregate_key] = version
        
        # Set timestamp if not set
        if not event.timestamp:
            event.timestamp = self._now()
        
        # Store event
        self._events.append(event)
        
        # Index by aggregate
        if event.aggregate_id not in self._by_aggregate:
            self._by_aggregate[event.aggregate_id] = []
        self._by_aggregate[event.aggregate_id].append(event)
        
        # Notify subscribers
        for handler in self._subscribers:
            try:
                await handler(event)
            except Exception:
                pass
    
    async def get_events(
        self,
        opts: Optional[FilterOptions] = None
    ) -> list[Event]:
        """Get events with filtering."""
        options = opts or FilterOptions()
        
        events = list(self._events)
        
        # Filter by aggregate ID
        if options.aggregate_id:
            events = [e for e in events if e.aggregate_id == options.aggregate_id]
        
        # Filter by aggregate type
        if options.aggregate_type:
            events = [e for e in events if e.aggregate_type == options.aggregate_type]
        
        # Filter by event type
        if options.event_type:
            events = [e for e in events if e.type == options.event_type]
        
        # Filter by timestamp
        if options.since:
            events = [e for e in events if e.timestamp >= options.since]
        
        # Apply limit
        if options.limit:
            events = events[-options.limit:]
        
        return events
    
    async def get_aggregate_events(
        self,
        aggregate_id: str
    ) -> list[Event]:
        """Get all events for an aggregate."""
        return self._by_aggregate.get(aggregate_id, []).copy()
    
    async def subscribe(self, handler: EventHandler) -> 'Subscription':
        """Subscribe to new events."""
        self._subscribers.append(handler)
        
        class Subscription:
            def __init__(self, log: 'MemoryEventLog', h: EventHandler):
                self._log = log
                self._handler = h
            
            async def unsubscribe(self) -> None:
                if self._handler in self._log._subscribers:
                    self._log._subscribers.remove(self._handler)
        
        return Subscription(self, handler)
    
    def clear(self) -> None:
        """Clear all events."""
        self._events.clear()
        self._by_aggregate.clear()
        self._version_map.clear()
    
    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)
