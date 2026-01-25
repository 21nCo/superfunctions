"""Priority queue implementation."""

import heapq
from typing import TypeVar, Generic, Callable, Optional


T = TypeVar('T')


class PriorityQueue(Generic[T]):
    """Priority queue using binary heap."""
    
    def __init__(
        self,
        comparator: Optional[Callable[[T, T], int]] = None
    ):
        """
        Initialize priority queue.
        
        Args:
            comparator: Function that returns negative if a < b, 
                       positive if a > b, 0 if equal.
                       If None, assumes items are comparable.
        """
        self.comparator = comparator
        self._heap: list[tuple[Any, int, T]] = []
        self._counter = 0
    
    def enqueue(self, item: T, priority: Optional[int] = None) -> None:
        """Add item to queue."""
        if priority is None:
            # Try to use item as priority if it's a number
            if isinstance(item, (int, float)):
                priority = item
            else:
                priority = 0
        
        # Use counter to maintain insertion order for same priorities
        heapq.heappush(self._heap, (priority, self._counter, item))
        self._counter += 1
    
    def dequeue(self) -> Optional[T]:
        """Remove and return highest priority item."""
        if not self._heap:
            return None
        
        _, _, item = heapq.heappop(self._heap)
        return item
    
    def peek(self) -> Optional[T]:
        """View highest priority item without removing."""
        if not self._heap:
            return None
        
        _, _, item = self._heap[0]
        return item
    
    def size(self) -> int:
        """Get queue size."""
        return len(self._heap)
    
    def is_empty(self) -> bool:
        """Check if queue is empty."""
        return len(self._heap) == 0
    
    def clear(self) -> None:
        """Clear all items."""
        self._heap.clear()
        self._counter = 0
