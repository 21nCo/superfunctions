"""
Memory storage backend with LRU eviction.
"""

import time
from collections import OrderedDict
from typing import Any, Optional

from ..core.types import CacheEntry, EntryMetadata
from ..utils.pattern import filter_by_pattern
from ..utils.ttl import is_expired


class MemoryStorage:
    """In-memory cache storage with LRU eviction."""

    def __init__(self, max_size: Optional[int] = None) -> None:
        """
        Initialize memory storage.

        Args:
            max_size: Maximum number of entries (None for unlimited)
        """
        self._cache: OrderedDict[str, CacheEntry[Any]] = OrderedDict()
        self._tags: dict[str, set[str]] = {}  # tag -> set of keys
        self._max_size = max_size
        self._eviction_callback: Optional[callable] = None

    def set_eviction_callback(self, callback: callable) -> None:
        """Set callback to be called when entries are evicted."""
        self._eviction_callback = callback

    async def get(self, key: str) -> Optional[Any]:
        """
        Get a value from storage.

        Args:
            key: Cache key

        Returns:
            Cached value or None if not found/expired
        """
        if key not in self._cache:
            return None

        entry = self._cache[key]

        # Check if expired
        if is_expired(entry.expires_at):
            await self.delete(key)
            return None

        # Update LRU order (move to end)
        self._cache.move_to_end(key)

        # Update access metadata
        entry.hits += 1
        entry.last_access = int(time.time() * 1000)

        return entry.value

    async def set(self, key: str, value: Any, metadata: EntryMetadata) -> None:
        """
        Set a value in storage.

        Args:
            key: Cache key
            value: Value to cache
            metadata: Entry metadata
        """
        # Check if we need to evict
        if self._max_size and key not in self._cache and len(self._cache) >= self._max_size:
            await self._evict_lru()

        # Create entry
        entry = CacheEntry(
            key=key,
            value=value,
            created_at=metadata.created_at,
            expires_at=metadata.expires_at,
            tags=metadata.tags,
            hits=metadata.hits,
            last_access=metadata.last_access,
        )

        # Store entry
        self._cache[key] = entry
        self._cache.move_to_end(key)  # Most recently used

        # Update tag index
        if metadata.tags:
            for tag in metadata.tags:
                if tag not in self._tags:
                    self._tags[tag] = set()
                self._tags[tag].add(key)

    async def has(self, key: str) -> bool:
        """
        Check if a key exists in storage.

        Args:
            key: Cache key

        Returns:
            True if key exists and not expired
        """
        if key not in self._cache:
            return False

        entry = self._cache[key]
        if is_expired(entry.expires_at):
            await self.delete(key)
            return False

        return True

    async def delete(self, key: str) -> bool:
        """
        Delete a value from storage.

        Args:
            key: Cache key

        Returns:
            True if key was deleted, False if not found
        """
        if key not in self._cache:
            return False

        entry = self._cache[key]

        # Remove from tag index
        if entry.tags:
            for tag in entry.tags:
                if tag in self._tags:
                    self._tags[tag].discard(key)
                    if not self._tags[tag]:
                        del self._tags[tag]

        # Remove from cache
        del self._cache[key]
        return True

    async def clear(self) -> None:
        """Clear all values from storage."""
        self._cache.clear()
        self._tags.clear()

    async def keys(self, pattern: Optional[str] = None) -> list[str]:
        """
        Get all keys matching a pattern.

        Args:
            pattern: Optional glob pattern to filter keys

        Returns:
            List of matching keys
        """
        all_keys = list(self._cache.keys())
        return filter_by_pattern(all_keys, pattern)

    async def size(self) -> int:
        """
        Get the number of entries in storage.

        Returns:
            Number of entries
        """
        return len(self._cache)

    async def get_keys_by_tag(self, tag: str) -> list[str]:
        """
        Get all keys with a specific tag.

        Args:
            tag: Tag to search for

        Returns:
            List of keys with the tag
        """
        if tag not in self._tags:
            return []
        return list(self._tags[tag])

    async def _evict_lru(self) -> None:
        """Evict the least recently used entry."""
        if not self._cache:
            return

        # Get the first (least recently used) key
        key = next(iter(self._cache))
        await self.delete(key)

        # Call eviction callback if set
        if self._eviction_callback:
            self._eviction_callback()

    def get_memory_usage(self) -> int:
        """
        Estimate memory usage in bytes.

        Returns:
            Estimated memory usage
        """
        # Rough estimate based on entry count
        return len(self._cache) * 200  # Assume ~200 bytes overhead per entry
