"""
Function memoization with caching.
"""

import functools
import inspect
import time
from collections import OrderedDict
from typing import Any, Callable, Optional, TypeVar

from ..core.cache import CacheFn, cache_fn
from ..core.types import CacheStats
from ..utils.hash import generate_key

F = TypeVar("F", bound=Callable[..., Any])


class MemoizedFunction:
    """Wrapper for memoized functions with cache control methods."""

    def __init__(
        self,
        func: Callable[..., Any],
        cache: CacheFn,
        key_generator: Callable[..., str],
        tags: Optional[list[str]] = None,
    ) -> None:
        """
        Initialize memoized function.

        Args:
            func: Original function
            cache: Cache instance
            key_generator: Key generation function
            tags: Optional tags for cache entries
        """
        self._func = func
        self._cache = cache
        self._key_generator = key_generator
        self._tags = tags
        functools.update_wrapper(self, func)

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        """
        Call the memoized function.

        Args:
            *args: Positional arguments
            **kwargs: Keyword arguments

        Returns:
            Cached or computed result
        """
        key = self._key_generator(*args, **kwargs)

        return await self._cache.get_or_fetch(
            key, lambda: self._func(*args, **kwargs), tags=self._tags
        )

    async def clear(self) -> None:
        """Clear all cached results."""
        await self._cache.clear()

    async def delete(self, *args: Any, **kwargs: Any) -> None:
        """
        Delete a specific cached result.

        Args:
            *args: Positional arguments
            **kwargs: Keyword arguments
        """
        key = self._key_generator(*args, **kwargs)
        await self._cache.delete(key)

    async def stats(self) -> CacheStats:
        """
        Get cache statistics.

        Returns:
            Cache statistics
        """
        return await self._cache.get_stats()


def memoize(
    ttl: Optional[int] = None,
    max_size: Optional[int] = None,
    storage: str = "memory",
    tags: Optional[list[str]] = None,
    key_generator: Optional[Callable[..., str]] = None,
) -> Callable[[F], MemoizedFunction]:
    """
    Decorator to memoize a function with caching.

    Args:
        ttl: Optional TTL in milliseconds
        max_size: Maximum cache size
        storage: Storage backend ('memory')
        tags: Optional tags for cache entries
        key_generator: Optional custom key generator function

    Returns:
        Decorator function

    Example:
        >>> @memoize(ttl=60000)
        >>> async def expensive_operation(id: str):
        ...     return await fetch_data(id)
    """

    def decorator(func: F) -> MemoizedFunction:
        # Create a dedicated cache instance for this function
        func_cache = cache_fn(
            name=f"memoize-{func.__name__}",
            storage=storage,
            max_size=1000 if max_size is None else max_size,
            default_ttl=ttl,
        )

        # Default key generator
        def default_key_gen(*args: Any, **kwargs: Any) -> str:
            return generate_key(func.__name__, *args, **kwargs)

        key_gen = key_generator or default_key_gen

        return MemoizedFunction(func, func_cache, key_gen, tags)

    return decorator


class MemoizedSyncFunction:
    """Wrapper for synchronous memoized functions."""

    def __init__(
        self,
        func: Callable[..., Any],
        key_generator: Callable[..., str],
        max_size: int = 1000,
        ttl: Optional[int] = None,
    ) -> None:
        """
        Initialize synchronous memoized function.

        Args:
            func: Original function
            key_generator: Key generation function
            max_size: Maximum cache size
        """
        self._func = func
        self._key_generator = key_generator
        if isinstance(max_size, bool) or not isinstance(max_size, int) or max_size <= 0:
            raise ValueError("max_size must be a positive integer")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, int) or ttl < 0):
            raise ValueError("ttl must be a non-negative integer or None")
        if inspect.iscoroutinefunction(func):
            raise TypeError("Use memoize for async functions")
        self._max_size = max_size
        self._ttl = ttl
        self._hits = self._misses = self._evictions = 0
        self._cache: OrderedDict[str, tuple[Any, Optional[float]]] = OrderedDict()
        self._next_expiration = float("inf")
        functools.update_wrapper(self, func)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        """
        Call the memoized function.

        Args:
            *args: Positional arguments
            **kwargs: Keyword arguments

        Returns:
            Cached or computed result
        """
        key = self._key_generator(*args, **kwargs)

        self._purge_expired()
        if key in self._cache:
            self._hits += 1
            self._cache.move_to_end(key)
            return self._cache[key][0]

        self._misses += 1
        result = self._func(*args, **kwargs)
        expires = None if self._ttl is None else time.monotonic() + self._ttl / 1000
        self._purge_expired()
        self._cache[key] = (result, expires)
        if expires is not None:
            self._next_expiration = min(self._next_expiration, expires)
        self._cache.move_to_end(key)
        if len(self._cache) > self._max_size:
            self._cache.popitem(last=False)
            self._evictions += 1
        return result

    def _purge_expired(self) -> None:
        now = time.monotonic()
        if now < self._next_expiration:
            return
        next_expiration = float("inf")
        for key, (_, expires) in list(self._cache.items()):
            if expires is not None:
                if expires <= now:
                    del self._cache[key]
                else:
                    next_expiration = min(next_expiration, expires)
        # Deletion/eviction can leave an early hint; it only causes an extra sweep.
        self._next_expiration = next_expiration

    def clear(self) -> None:
        """Clear all cached results."""
        self._cache.clear()
        self._next_expiration = float("inf")
        self._hits = self._misses = self._evictions = 0

    def delete(self, *args: Any, **kwargs: Any) -> None:
        """
        Delete a specific cached result.

        Args:
            *args: Positional arguments
            **kwargs: Keyword arguments
        """
        key = self._key_generator(*args, **kwargs)
        self._cache.pop(key, None)

    def stats(self) -> dict[str, Any]:
        """
        Get cache statistics.

        Returns:
            Basic statistics dict
        """
        self._purge_expired()
        total = self._hits + self._misses
        return {
            "size": len(self._cache),
            "max_size": self._max_size,
            "hits": self._hits,
            "misses": self._misses,
            "evictions": self._evictions,
            "hit_rate": self._hits / total * 100 if total else 0.0,
        }


def memoize_sync(
    max_size: int = 1000,
    key_generator: Optional[Callable[..., str]] = None,
    ttl: Optional[int] = None,
) -> Callable[[F], MemoizedSyncFunction]:
    """
    Decorator to memoize a synchronous function (non-async).

    Args:
        max_size: Maximum cache size
        key_generator: Optional custom key generator function

    Returns:
        Decorator function

    Example:
        >>> @memoize_sync(max_size=500)
        >>> def fibonacci(n: int) -> int:
        ...     if n <= 1:
        ...         return n
        ...     return fibonacci(n - 1) + fibonacci(n - 2)
    """

    def decorator(func: F) -> MemoizedSyncFunction:
        # Default key generator
        def default_key_gen(*args: Any, **kwargs: Any) -> str:
            return generate_key(func.__name__, *args, **kwargs)

        key_gen = key_generator or default_key_gen

        return MemoizedSyncFunction(func, key_gen, max_size, ttl)

    return decorator
