"""Batching pattern utilities."""

import asyncio
from typing import Any, Callable, Awaitable, Optional, TypeVar, Generic
from collections import defaultdict


T = TypeVar('T')
R = TypeVar('R')


class BatchAccumulator(Generic[T]):
    """Accumulates items into batches."""
    
    def __init__(
        self,
        max_size: int,
        max_wait: int,
        processor: Callable[[list[T]], Awaitable[None]]
    ):
        self.max_size = max_size
        self.max_wait = max_wait
        self.processor = processor
        self._batch: list[T] = []
        self._timer: Optional[asyncio.Task[None]] = None
        self._lock = asyncio.Lock()
    
    async def add(self, item: T) -> None:
        """Add item to batch."""
        async with self._lock:
            self._batch.append(item)
            
            # Start timer if not running
            if not self._timer:
                self._timer = asyncio.create_task(self._wait_and_flush())
            
            # Flush if batch is full
            if len(self._batch) >= self.max_size:
                await self._flush()
    
    async def _wait_and_flush(self) -> None:
        """Wait for max_wait then flush."""
        await asyncio.sleep(self.max_wait / 1000.0)
        async with self._lock:
            await self._flush()
    
    async def _flush(self) -> None:
        """Flush current batch."""
        if not self._batch:
            return
        
        # Cancel timer
        if self._timer:
            self._timer.cancel()
            self._timer = None
        
        # Process batch
        batch = self._batch.copy()
        self._batch.clear()
        
        await self.processor(batch)
    
    async def flush(self) -> None:
        """Manually flush batch."""
        async with self._lock:
            await self._flush()


class BatchWriter(Generic[T]):
    """Auto-flushing batch writer."""
    
    def __init__(
        self,
        batch_size: int,
        writer: Callable[[list[T]], Awaitable[None]]
    ):
        self.batch_size = batch_size
        self.writer = writer
        self._batch: list[T] = []
        self._lock = asyncio.Lock()
    
    async def write(self, item: T) -> None:
        """Write item to batch."""
        async with self._lock:
            self._batch.append(item)
            
            if len(self._batch) >= self.batch_size:
                await self._flush()
    
    async def _flush(self) -> None:
        """Flush batch."""
        if not self._batch:
            return
        
        batch = self._batch.copy()
        self._batch.clear()
        await self.writer(batch)
    
    async def close(self) -> None:
        """Close and flush remaining items."""
        async with self._lock:
            await self._flush()


def chunk(items: list[T], size: int) -> list[list[T]]:
    """Split list into chunks."""
    return [items[i:i + size] for i in range(0, len(items), size)]


async def process_batches(
    items: list[T],
    batch_size: int,
    processor: Callable[[list[T]], Awaitable[R]]
) -> list[R]:
    """Process items in batches."""
    batches = chunk(items, batch_size)
    results = []
    
    for batch in batches:
        result = await processor(batch)
        results.append(result)
    
    return results


def batch_by_key(
    items: list[T],
    key_fn: Callable[[T], str]
) -> dict[str, list[T]]:
    """Group items by key function."""
    batches: dict[str, list[T]] = defaultdict(list)
    
    for item in items:
        key = key_fn(item)
        batches[key].append(item)
    
    return dict(batches)
