"""
Statistics tracking for cache operations.
"""

from ..core.types import CacheStats


class StatsTracker:
    """Track cache statistics."""

    def __init__(self) -> None:
        """Initialize stats tracker."""
        self._hits: int = 0
        self._misses: int = 0
        self._sets: int = 0
        self._deletes: int = 0
        self._evictions: int = 0

    def record_hit(self) -> None:
        """Record a cache hit."""
        self._hits += 1

    def record_miss(self) -> None:
        """Record a cache miss."""
        self._misses += 1

    def record_set(self) -> None:
        """Record a set operation."""
        self._sets += 1

    def record_delete(self) -> None:
        """Record a delete operation."""
        self._deletes += 1

    def record_eviction(self) -> None:
        """Record an eviction."""
        self._evictions += 1

    def get_stats(self, size: int, memory_usage: int | None = None) -> CacheStats:
        """
        Get current statistics.

        Args:
            size: Current cache size
            memory_usage: Optional memory usage in bytes

        Returns:
            Cache statistics
        """
        total_requests = self._hits + self._misses
        hit_rate = (self._hits / total_requests * 100) if total_requests > 0 else 0.0

        return CacheStats(
            hits=self._hits,
            misses=self._misses,
            hit_rate=hit_rate,
            sets=self._sets,
            deletes=self._deletes,
            evictions=self._evictions,
            size=size,
            memory_usage=memory_usage,
        )

    def reset(self) -> None:
        """Reset all statistics."""
        self._hits = 0
        self._misses = 0
        self._sets = 0
        self._deletes = 0
        self._evictions = 0
