"""
cachefn - Self-hosted caching solution for Python applications.

Example usage:
    >>> from cachefn import CacheFn, cache_fn, memoize
    >>> 
    >>> # Create a cache instance
    >>> cache = cache_fn(name="my-cache", storage="memory", max_size=1000)
    >>> 
    >>> # Set and get values
    >>> await cache.set("user:123", {"name": "Alice", "age": 30})
    >>> user = await cache.get("user:123")
    >>> 
    >>> # Memoize expensive functions
    >>> @memoize(ttl=60000)
    >>> async def expensive_operation(id: str):
    ...     return await fetch_data(id)
"""

__version__ = "0.1.0"
__author__ = "SuperFunctions"
__license__ = "Apache-2.0"

from .core.cache import CacheFn, cache_fn
from .core.types import (
    CacheFnConfig,
    CacheStats,
    SetOptions,
    StorageType,
    CacheEntry,
    MemoizeOptions,
)
from .memoization.memoize import memoize, memoize_sync
from .storage.memory_storage import MemoryStorage
from .utils.hash import generate_key, hash_args, hash_value

__all__ = [
    "__version__",
    "__author__",
    "__license__",
    # Main classes and factory
    "CacheFn",
    "cache_fn",
    # Configuration and types
    "CacheFnConfig",
    "CacheStats",
    "SetOptions",
    "StorageType",
    "CacheEntry",
    "MemoizeOptions",
    # Memoization
    "memoize",
    "memoize_sync",
    # Storage
    "MemoryStorage",
    # Utilities
    "generate_key",
    "hash_args",
    "hash_value",
]
