"""
Function memoization with caching.
"""

import asyncio
import functools
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

        # Try to get from cache
        cached = await self._cache.get(key)
        if cached is not None:
            return cached

        # Call the original function
        if asyncio.iscoroutinefunction(self._func):
            result = await self._func(*args, **kwargs)
        else:
            result = self._func(*args, **kwargs)

        # Store in cache
        await self._cache.set(key, result, tags=self._tags)

        return result

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
            max_size=max_size or 1000,
            default_ttl=ttl,
        )

        # Default key generator
        default_key_gen = lambda *args, **kwargs: generate_key(func.__name__, *args, **kwargs)
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
        self._max_size = max_size
        self._cache: dict[str, Any] = {}
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

        # Check cache
        if key in self._cache:
            return self._cache[key]

        # Call original function
        result = self._func(*args, **kwargs)

        # Store in cache
        self._cache[key] = result

        # Evict oldest if over max size (simple FIFO)
        if len(self._cache) > self._max_size:
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]

        return result

    def clear(self) -> None:
        """Clear all cached results."""
        self._cache.clear()

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
        return {"size": len(self._cache), "max_size": self._max_size}


def memoize_sync(
    max_size: int = 1000,
    key_generator: Optional[Callable[..., str]] = None,
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
        default_key_gen = lambda *args, **kwargs: generate_key(func.__name__, *args, **kwargs)
        key_gen = key_generator or default_key_gen

        return MemoizedSyncFunction(func, key_gen, max_size)

    return decorator
