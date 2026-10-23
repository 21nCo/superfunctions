"""
Event emitter for cache events.
"""

from collections import defaultdict
from typing import Any, Callable


class EventEmitter:
    """Simple event emitter for cache events."""

    def __init__(self) -> None:
        """Initialize event emitter."""
        self._handlers: dict[str, list[Callable[[Any], None]]] = defaultdict(list)

    def on(self, event: str, handler: Callable[[Any], None]) -> None:
        """Register an event handler.

        Args:
            event: Event name
            handler: Event handler function
        """
        self._handlers[event].append(handler)

    def off(self, event: str, handler: Callable[[Any], None]) -> None:
        """Unregister an event handler.

        Args:
            event: Event name
            handler: Event handler function to remove
        """
        if event in self._handlers:
            self._handlers[event].remove(handler)

    def emit(self, event: str, data: Any) -> None:
        """Emit an event.

        Args:
            event: Event name
            data: Event data
        """
        if event in self._handlers:
            for handler in self._handlers[event]:
                try:
                    handler(data)
                except Exception:
                    # Silently ignore handler errors
                    pass

    def remove_all_listeners(self, event: Optional[str] = None) -> None:
        """Remove all listeners for an event or all events.

        Args:
            event: Event name, or None to remove all listeners
        """
        if event is None:
            self._handlers.clear()
        elif event in self._handlers:
            del self._handlers[event]


# Type alias
from typing import Optional
