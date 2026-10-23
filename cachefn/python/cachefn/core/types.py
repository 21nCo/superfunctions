"""
Core type definitions for CacheFn.
"""

from typing import Any, Callable, Generic, Literal, Optional, Protocol, TypeVar
from pydantic import BaseModel, Field


# Storage types
StorageType = Literal["memory"]

T = TypeVar("T")
P = TypeVar("P")


class CacheFnConfig(BaseModel):
    """Configuration options for CacheFn instance."""

    name: str = Field(..., description="Unique name for the cache instance")
    storage: StorageType = Field(default="memory", description="Storage backend to use")
    max_size: Optional[int] = Field(
        default=None, description="Maximum number of entries (for memory storage)"
    )
    default_ttl: Optional[int] = Field(default=None, description="Default TTL in milliseconds")
    namespace: Optional[str] = Field(default=None, description="Namespace for cache keys")

    class Config:
        """Pydantic config."""

        frozen = True


class SetOptions(BaseModel):
    """Options for setting cache entries."""

    ttl: Optional[int] = Field(default=None, description="Time-to-live in milliseconds")
    tags: Optional[list[str]] = Field(default=None, description="Tags for invalidation")

    class Config:
        """Pydantic config."""

        frozen = True


class EntryMetadata(BaseModel):
    """Metadata for cache entries."""

    created_at: int = Field(..., description="Creation timestamp")
    expires_at: Optional[int] = Field(default=None, description="Expiration timestamp")
    tags: Optional[list[str]] = Field(default=None, description="Tags for invalidation")
    hits: int = Field(default=0, description="Number of cache hits")
    last_access: int = Field(..., description="Last access timestamp")

    class Config:
        """Pydantic config."""

        frozen = True


class CacheEntry(BaseModel, Generic[T]):
    """Internal cache entry structure."""

    key: str = Field(..., description="Cache key")
    value: T = Field(..., description="Cached value")
    created_at: int = Field(..., description="Creation timestamp")
    expires_at: Optional[int] = Field(default=None, description="Expiration timestamp")
    tags: Optional[list[str]] = Field(default=None, description="Tags for invalidation")
    hits: int = Field(default=0, description="Number of cache hits")
    last_access: int = Field(..., description="Last access timestamp")

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True


class CacheStats(BaseModel):
    """Cache statistics."""

    hits: int = Field(default=0, description="Total cache hits")
    misses: int = Field(default=0, description="Total cache misses")
    hit_rate: float = Field(default=0.0, description="Hit rate percentage")
    sets: int = Field(default=0, description="Total set operations")
    deletes: int = Field(default=0, description="Total delete operations")
    evictions: int = Field(default=0, description="Total evictions")
    size: int = Field(default=0, description="Current cache size")
    memory_usage: Optional[int] = Field(
        default=None, description="Estimated memory usage in bytes (memory storage only)"
    )

    class Config:
        """Pydantic config."""

        frozen = True


class CacheEvent(BaseModel):
    """Base class for cache events."""

    pass


class HitEvent(CacheEvent):
    """Cache hit event."""

    key: str
    access_time: float


class MissEvent(CacheEvent):
    """Cache miss event."""

    key: str


class SetEvent(CacheEvent):
    """Cache set event."""

    key: str
    size: int


class DeleteEvent(CacheEvent):
    """Cache delete event."""

    key: str


class EvictionEvent(CacheEvent):
    """Cache eviction event."""

    key: str
    reason: str


class InvalidateEvent(CacheEvent):
    """Cache invalidation event."""

    pattern: str
    count: int


# Event handler type
EventHandler = Callable[[CacheEvent], None]


class MemoizeOptions(BaseModel):
    """Memoization options."""

    key_generator: Optional[Callable[..., str]] = Field(
        default=None, description="Custom key generator function"
    )
    ttl: Optional[int] = Field(default=None, description="Time-to-live in milliseconds")
    max_size: Optional[int] = Field(default=None, description="Maximum cache size")
    storage: StorageType = Field(default="memory", description="Storage backend")
    tags: Optional[list[str]] = Field(default=None, description="Tags for invalidation")

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True
        frozen = True


class StorageBackend(Protocol[T]):
    """Storage backend protocol."""

    async def get(self, key: str) -> Optional[T]:
        """Get a value from storage."""
        ...

    async def set(self, key: str, value: T, metadata: EntryMetadata) -> None:
        """Set a value in storage."""
        ...

    async def has(self, key: str) -> bool:
        """Check if a key exists in storage."""
        ...

    async def delete(self, key: str) -> bool:
        """Delete a value from storage."""
        ...

    async def clear(self) -> None:
        """Clear all values from storage."""
        ...

    async def keys(self, pattern: Optional[str] = None) -> list[str]:
        """Get all keys matching a pattern."""
        ...

    async def size(self) -> int:
        """Get the number of entries in storage."""
        ...

    async def get_keys_by_tag(self, tag: str) -> list[str]:
        """Get all keys with a specific tag."""
        ...
