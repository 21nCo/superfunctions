"""
Tests for memoization functionality.
"""

import asyncio
import pytest
from cachefn import memoize, memoize_sync


@pytest.mark.asyncio
async def test_async_memoize() -> None:
    """Test async function memoization."""
    call_count = 0

    @memoize(ttl=60000)
    async def expensive_function(x: int) -> int:
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.01)
        return x * 2

    # First call
    result = await expensive_function(5)
    assert result == 10
    assert call_count == 1

    # Second call - should use cache
    result = await expensive_function(5)
    assert result == 10
    assert call_count == 1

    # Different argument - should call function
    result = await expensive_function(10)
    assert result == 20
    assert call_count == 2


@pytest.mark.asyncio
async def test_async_memoize_clear() -> None:
    """Test clearing memoized async function cache."""
    call_count = 0

    @memoize()
    async def func(x: int) -> int:
        nonlocal call_count
        call_count += 1
        return x * 2

    # Call twice
    await func(5)
    await func(5)
    assert call_count == 1

    # Clear cache
    await func.clear()

    # Call again - should recompute
    await func(5)
    assert call_count == 2


@pytest.mark.asyncio
async def test_async_memoize_delete() -> None:
    """Test deleting specific memoized result."""
    call_count = 0

    @memoize()
    async def func(x: int) -> int:
        nonlocal call_count
        call_count += 1
        return x * 2

    # Call with different args
    await func(5)
    await func(10)
    assert call_count == 2

    # Delete one result
    await func.delete(5)

    # Call again
    await func(5)  # should recompute
    await func(10)  # should use cache
    assert call_count == 3


@pytest.mark.asyncio
async def test_async_memoize_ttl() -> None:
    """Test TTL expiration in memoized function."""
    call_count = 0

    @memoize(ttl=100)  # 100ms TTL
    async def func(x: int) -> int:
        nonlocal call_count
        call_count += 1
        return x * 2

    # First call
    result = await func(5)
    assert call_count == 1

    # Wait for expiration
    await asyncio.sleep(0.15)

    # Should recompute
    result = await func(5)
    assert call_count == 2


@pytest.mark.asyncio
async def test_custom_key_generator() -> None:
    """Test custom key generator."""
    call_count = 0

    @memoize(key_generator=lambda x, y: f"custom:{x}:{y}")
    async def func(x: int, y: int) -> int:
        nonlocal call_count
        call_count += 1
        return x + y

    # Call twice with same args
    await func(1, 2)
    await func(1, 2)
    assert call_count == 1

    # Different args
    await func(2, 3)
    assert call_count == 2


def test_sync_memoize() -> None:
    """Test synchronous function memoization."""
    call_count = 0

    @memoize_sync()
    def fibonacci(n: int) -> int:
        nonlocal call_count
        call_count += 1
        if n <= 1:
            return n
        return fibonacci(n - 1) + fibonacci(n - 2)

    # Compute fibonacci
    result = fibonacci(10)
    assert result == 55

    # Should have computed each unique n only once
    # fibonacci(10) requires: 0,1,2,3,4,5,6,7,8,9,10 = 11 calls
    assert call_count == 11

    # Reset counter and clear cache
    call_count = 0
    fibonacci.clear()

    # Compute again - should recompute
    result = fibonacci(10)
    assert result == 55
    assert call_count == 11


def test_sync_memoize_delete() -> None:
    """Test deleting specific result from sync memoization."""
    call_count = 0

    @memoize_sync()
    def func(x: int) -> int:
        nonlocal call_count
        call_count += 1
        return x * 2

    # Call twice
    func(5)
    func(5)
    assert call_count == 1

    # Delete result
    func.delete(5)

    # Call again - should recompute
    func(5)
    assert call_count == 2


def test_sync_memoize_max_size() -> None:
    """Test max size eviction in sync memoization."""
    call_count = 0

    @memoize_sync(max_size=3)
    def func(x: int) -> int:
        nonlocal call_count
        call_count += 1
        return x * 2

    # Fill cache
    func(1)
    func(2)
    func(3)
    assert call_count == 3

    # Add one more - should evict oldest
    func(4)
    assert call_count == 4

    # Call evicted value - should recompute
    func(1)
    assert call_count == 5


def test_sync_memoize_stats() -> None:
    """Test getting stats from sync memoization."""

    @memoize_sync(max_size=100)
    def func(x: int) -> int:
        return x * 2

    func(1)
    func(2)
    func(3)

    stats = func.stats()
    assert stats["size"] == 3
    assert stats["max_size"] == 100


@pytest.mark.asyncio
async def test_memoize_with_tags() -> None:
    """Test memoization with tags."""

    @memoize(tags=["test-tag"])
    async def func(x: int) -> int:
        return x * 2

    result = await func(5)
    assert result == 10

    # Get stats
    stats = await func.stats()
    assert stats.size > 0
