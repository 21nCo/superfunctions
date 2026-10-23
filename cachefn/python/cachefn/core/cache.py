"""
Main CacheFn class implementation.
"""

import re
import time
from typing import Any, Callable, Optional

from ..analytics.stats import StatsTracker
from ..core.events import EventEmitter
from ..core.types import (
    CacheFnConfig,
    CacheStats,
    DeleteEvent,
    EntryMetadata,
    EvictionEvent,
    HitEvent,
    InvalidateEvent,
    MissEvent,
    SetEvent,
    StorageBackend,
)
from ..storage.memory_storage import MemoryStorage
from ..utils.pattern import filter_by_pattern
from ..utils.ttl import calculate_expiration


class CacheFn:
    """Self-hosted caching solution for Python."""

    def __init__(self, config: CacheFnConfig) -> None:
        """
        Initialize CacheFn instance.

        Args:
            config: Cache configuration
        """
        self._config = config
        self._default_ttl = config.default_ttl
        self._namespace = config.namespace
        self._events = EventEmitter()
        self._stats = StatsTracker()

        # Initialize storage backend
        self._storage = self._create_storage(config)

        # Set eviction callback for stats
        if hasattr(self._storage, "set_eviction_callback"):
            self._storage.set_eviction_callback(self._on_eviction)

    def _create_storage(self, config: CacheFnConfig) -> StorageBackend[Any]:
        """
        Create storage backend based on config.

        Args:
            config: Cache configuration

        Returns:
            Storage backend instance
        """
        if config.storage == "memory":
            return MemoryStorage(max_size=config.max_size)
        else:
            raise ValueError(f"Unsupported storage type: {config.storage}")

    def _get_full_key(self, key: str) -> str:
        """
        Get full key with namespace prefix.

        Args:
            key: Cache key

        Returns:
            Full key with namespace
        """
        if self._namespace:
            return f"{self._namespace}:{key}"
        return key

    def _strip_namespace(self, key: str) -> str:
        """
        Strip namespace from key.

        Args:
            key: Full key with namespace

        Returns:
            Key without namespace
        """
        if self._namespace and key.startswith(f"{self._namespace}:"):
            return key[len(self._namespace) + 1 :]
        return key

    async def get(self, key: str) -> Optional[Any]:
        """
        Get a value from cache.

        Args:
            key: Cache key

        Returns:
            Cached value or None if not found/expired
        """
        full_key = self._get_full_key(key)
        start_time = time.perf_counter()

        value = await self._storage.get(full_key)
        access_time = (time.perf_counter() - start_time) * 1000  # Convert to ms

        if value is not None:
            self._stats.record_hit()
            self._events.emit("hit", HitEvent(key=full_key, access_time=access_time))
        else:
            self._stats.record_miss()
            self._events.emit("miss", MissEvent(key=full_key))

        return value

    async def set(
        self, key: str, value: Any, ttl: Optional[int] = None, tags: Optional[list[str]] = None
    ) -> None:
        """
        Set a value in cache.

        Args:
            key: Cache key
            value: Value to cache
            ttl: Optional TTL in milliseconds
            tags: Optional tags for invalidation
        """
        full_key = self._get_full_key(key)
        effective_ttl = ttl if ttl is not None else self._default_ttl

        metadata = EntryMetadata(
            created_at=int(time.time() * 1000),
            expires_at=calculate_expiration(effective_ttl),
            tags=tags,
            hits=0,
            last_access=int(time.time() * 1000),
        )

        await self._storage.set(full_key, value, metadata)

        self._stats.record_set()
        self._events.emit("set", SetEvent(key=full_key, size=1))

    async def has(self, key: str) -> bool:
        """
        Check if a key exists in cache.

        Args:
            key: Cache key

        Returns:
            True if key exists and not expired
        """
        full_key = self._get_full_key(key)
        return await self._storage.has(full_key)

    async def delete(self, key: str) -> bool:
        """
        Delete a value from cache.

        Args:
            key: Cache key

        Returns:
            True if key was deleted, False if not found
        """
        full_key = self._get_full_key(key)
        deleted = await self._storage.delete(full_key)

        if deleted:
            self._stats.record_delete()
            self._events.emit("delete", DeleteEvent(key=full_key))

        return deleted

    async def clear(self) -> None:
        """Clear all values from cache."""
        await self._storage.clear()
        self._stats.reset()

    async def get_many(self, keys: list[str]) -> list[Optional[Any]]:
        """
        Get multiple values from cache.

        Args:
            keys: List of cache keys

        Returns:
            List of values (None for missing/expired keys)
        """
        results = []
        for key in keys:
            value = await self.get(key)
            results.append(value)
        return results

    async def set_many(
        self,
        entries: list[dict[str, Any]],
    ) -> None:
        """
        Set multiple values in cache.

        Args:
            entries: List of dicts with 'key', 'value', and optional 'ttl', 'tags'
        """
        for entry in entries:
            await self.set(
                entry["key"],
                entry["value"],
                ttl=entry.get("ttl"),
                tags=entry.get("tags"),
            )

    async def delete_many(self, keys: list[str]) -> None:
        """
        Delete multiple values from cache.

        Args:
            keys: List of cache keys
        """
        for key in keys:
            await self.delete(key)

    async def keys(self, pattern: Optional[str] = None) -> list[str]:
        """
        Get all keys matching a pattern.

        Args:
            pattern: Optional glob pattern to filter keys

        Returns:
            List of matching keys (without namespace)
        """
        all_keys = await self._storage.keys()

        # Strip namespace from keys
        keys_without_namespace = [self._strip_namespace(key) for key in all_keys]

        return filter_by_pattern(keys_without_namespace, pattern)

    async def size(self) -> int:
        """
        Get the number of entries in cache.

        Returns:
            Number of entries
        """
        return await self._storage.size()

    async def get_or_fetch(
        self,
        key: str,
        fetcher: Callable[[], Any],
        ttl: Optional[int] = None,
        tags: Optional[list[str]] = None,
    ) -> Any:
        """
        Get a value from cache or fetch it if not present (cache-aside pattern).

        Args:
            key: Cache key
            fetcher: Function to fetch value if not cached
            ttl: Optional TTL in milliseconds
            tags: Optional tags for invalidation

        Returns:
            Cached or fetched value
        """
        cached = await self.get(key)

        if cached is not None:
            return cached

        value = await fetcher() if callable(fetcher) else fetcher
        await self.set(key, value, ttl=ttl, tags=tags)

        return value

    async def invalidate(self, key: str) -> bool:
        """
        Invalidate a single key (alias for delete).

        Args:
            key: Cache key

        Returns:
            True if key was invalidated
        """
        return await self.delete(key)

    async def invalidate_by_tag(self, tag: str) -> None:
        """
        Invalidate all keys with a specific tag.

        Args:
            tag: Tag to invalidate
        """
        keys = await self._storage.get_keys_by_tag(tag)
        count = len(keys)

        for key in keys:
            await self._storage.delete(key)

        self._events.emit("invalidate", InvalidateEvent(pattern=f"tag:{tag}", count=count))

    async def invalidate_by_tags(self, tags: list[str]) -> None:
        """
        Invalidate all keys with any of the specified tags.

        Args:
            tags: List of tags to invalidate
        """
        for tag in tags:
            await self.invalidate_by_tag(tag)

    async def invalidate_by_pattern(self, pattern: str | re.Pattern[str]) -> None:
        """
        Invalidate all keys matching a pattern.

        Args:
            pattern: Glob pattern or regex to match keys
        """
        all_keys = await self.keys()
        matching_keys = filter_by_pattern(all_keys, pattern)
        count = len(matching_keys)

        for key in matching_keys:
            await self.delete(key)

        pattern_str = pattern if isinstance(pattern, str) else pattern.pattern
        self._events.emit("invalidate", InvalidateEvent(pattern=pattern_str, count=count))

    async def touch(self, key: str) -> None:
        """
        Update the last access time of a key without fetching the value.

        Args:
            key: Cache key
        """
        # Get and set back to update access time
        value = await self.get(key)
        if value is not None:
            # Value was already touched by get() due to LRU update
            pass

    async def entries(
        self, pattern: Optional[str] = None, limit: Optional[int] = None
    ) -> list[dict[str, Any]]:
        """
        Get cache entries matching a pattern.

        Args:
            pattern: Optional glob pattern to filter keys
            limit: Optional limit on number of entries

        Returns:
            List of dicts with 'key' and 'value'
        """
        keys = await self.keys(pattern)

        if limit:
            keys = keys[:limit]

        entries = []
        for key in keys:
            value = await self.get(key)
            if value is not None:
                entries.append({"key": key, "value": value})

        return entries

    async def get_stats(self) -> CacheStats:
        """
        Get cache statistics.

        Returns:
            Cache statistics
        """
        size = await self.size()
        memory_usage = None

        if hasattr(self._storage, "get_memory_usage"):
            memory_usage = self._storage.get_memory_usage()

        return self._stats.get_stats(size=size, memory_usage=memory_usage)

    def on(self, event: str, handler: Callable[[Any], None]) -> None:
        """
        Register an event handler.

        Args:
            event: Event name ('hit', 'miss', 'set', 'delete', 'eviction', 'invalidate')
            handler: Event handler function
        """
        self._events.on(event, handler)

    def off(self, event: str, handler: Callable[[Any], None]) -> None:
        """
        Unregister an event handler.

        Args:
            event: Event name
            handler: Event handler function to remove
        """
        self._events.off(event, handler)

    def _on_eviction(self) -> None:
        """Handle eviction event from storage."""
        self._stats.record_eviction()
        self._events.emit("eviction", EvictionEvent(key="unknown", reason="lru"))


def cache_fn(
    name: str,
    storage: str = "memory",
    max_size: Optional[int] = None,
    default_ttl: Optional[int] = None,
    namespace: Optional[str] = None,
) -> CacheFn:
    """
    Create a new cache instance (factory function).

    Args:
        name: Unique name for the cache instance
        storage: Storage backend to use ('memory')
        max_size: Maximum number of entries (for memory storage)
        default_ttl: Default TTL in milliseconds
        namespace: Namespace for cache keys

    Returns:
        CacheFn instance
    """
    config = CacheFnConfig(
        name=name,
        storage=storage,  # type: ignore
        max_size=max_size,
        default_ttl=default_ttl,
        namespace=namespace,
    )
    return CacheFn(config)
