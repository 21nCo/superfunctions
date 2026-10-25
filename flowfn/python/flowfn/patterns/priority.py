"""Stable priority queue using binary heap."""

import heapq
from dataclasses import dataclass, field
from functools import cmp_to_key
from typing import Any, Callable, Generic, Optional, TypeVar

T = TypeVar("T")


@dataclass(order=True)
class _Entry(Generic[T]):
    priority: float
    key: Any
    sequence: int
    item: T = field(compare=False)


class PriorityQueue(Generic[T]):
    """Explicit numeric priority first, comparator order second, FIFO for ties."""

    def __init__(self, comparator: Optional[Callable[[T, T], int]] = None) -> None:
        self.comparator = comparator
        self._key = cmp_to_key(comparator) if comparator is not None else None
        self._heap: list[_Entry[T]] = []
        self._counter = 0

    def enqueue(self, item: T, priority: Optional[int] = None) -> None:
        key = self._key(item) if self._key is not None else 0
        rank = (
            priority
            if priority is not None
            else (item if self._key is None and isinstance(item, (int, float)) else 0)
        )
        entry = _Entry(rank, key, self._counter, item)
        heapq.heappush(self._heap, entry)
        self._counter += 1

    def dequeue(self) -> Optional[T]:
        return heapq.heappop(self._heap).item if self._heap else None

    def peek(self) -> Optional[T]:
        return self._heap[0].item if self._heap else None

    def size(self) -> int:
        return len(self._heap)

    def is_empty(self) -> bool:
        return not self._heap

    def clear(self) -> None:
        self._heap.clear()
        self._counter = 0
