"""Event routing and ingestion for WatchFn."""

from typing import Any, Dict, List, Callable, Optional
from ..models import Event
from ..utils.batching import Batcher


class EventRouter:
    """Route and process incoming events."""
    
    def __init__(self):
        self.handlers: Dict[str, List[Callable[[Event], None]]] = {}
        self.global_handlers: List[Callable[[Event], None]] = []
    
    def register(self, event_type: str, handler: Callable[[Event], None]) -> None:
        """Register a handler for a specific event type."""
        if event_type not in self.handlers:
            self.handlers[event_type] = []
        self.handlers[event_type].append(handler)
    
    def register_global(self, handler: Callable[[Event], None]) -> None:
        """Register a global handler that receives all events."""
        self.global_handlers.append(handler)
    
    def route(self, event: Event) -> None:
        """Route an event to its handlers."""
        # Call global handlers
        for handler in self.global_handlers:
            try:
                handler(event)
            except Exception as e:
                print(f"Error in global handler: {e}")
        
        # Call type-specific handlers
        if event.type in self.handlers:
            for handler in self.handlers[event.type]:
                try:
                    handler(event)
                except Exception as e:
                    print(f"Error in handler for {event.type}: {e}")
    
    def route_batch(self, events: List[Event]) -> None:
        """Route multiple events."""
        for event in events:
            self.route(event)
