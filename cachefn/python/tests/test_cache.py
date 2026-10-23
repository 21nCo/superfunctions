"""
Tests for CacheFn core functionality.
"""

import asyncio
import pytest
from cachefn import CacheFn, cache_fn, CacheFnConfig


@pytest.fixture
def cache() -> CacheFn:
    """Create a test cache instance."""
    return cache_fn(name="test-cache", storage="memory", max_size=10)


@pytest.mark.asyncio
async def test_basic_get_set(cache: CacheFn) -> None:
    """Test basic get and set operations."""
    # Set a value
    await cache.set("key1", "value1")

    # Get the value
    value = await cache.get("key1")
    assert value == "value1"

    # Get non-existent key
    value = await cache.get("key2")
    assert value is None


@pytest.mark.asyncio
async def test_has(cache: CacheFn) -> None:
    """Test has operation."""
    await cache.set("key1", "value1")

    assert await cache.has("key1") is True
    assert await cache.has("key2") is False


@pytest.mark.asyncio
async def test_delete(cache: CacheFn) -> None:
    """Test delete operation."""
    await cache.set("key1", "value1")

    # Delete existing key
    deleted = await cache.delete("key1")
    assert deleted is True

    # Verify deletion
    value = await cache.get("key1")
    assert value is None

    # Delete non-existent key
    deleted = await cache.delete("key2")
    assert deleted is False


@pytest.mark.asyncio
async def test_clear(cache: CacheFn) -> None:
    """Test clear operation."""
    await cache.set("key1", "value1")
    await cache.set("key2", "value2")

    size = await cache.size()
    assert size == 2

    await cache.clear()

    size = await cache.size()
    assert size == 0


@pytest.mark.asyncio
async def test_ttl_expiration(cache: CacheFn) -> None:
    """Test TTL expiration."""
    # Set with 100ms TTL
    await cache.set("key1", "value1", ttl=100)

    # Value should exist immediately
    value = await cache.get("key1")
    assert value == "value1"

    # Wait for expiration
    await asyncio.sleep(0.15)

    # Value should be expired
    value = await cache.get("key1")
    assert value is None


@pytest.mark.asyncio
async def test_tags(cache: CacheFn) -> None:
    """Test tag-based operations."""
    # Set values with tags
    await cache.set("key1", "value1", tags=["tag1", "tag2"])
    await cache.set("key2", "value2", tags=["tag1"])
    await cache.set("key3", "value3", tags=["tag2"])

    # Invalidate by tag
    await cache.invalidate_by_tag("tag1")

    # Check results
    assert await cache.get("key1") is None
    assert await cache.get("key2") is None
    assert await cache.get("key3") == "value3"


@pytest.mark.asyncio
async def test_batch_operations(cache: CacheFn) -> None:
    """Test batch get/set/delete operations."""
    # Set many
    await cache.set_many(
        [
            {"key": "key1", "value": "value1"},
            {"key": "key2", "value": "value2"},
            {"key": "key3", "value": "value3"},
        ]
    )

    # Get many
    values = await cache.get_many(["key1", "key2", "key3", "key4"])
    assert values == ["value1", "value2", "value3", None]

    # Delete many
    await cache.delete_many(["key1", "key2"])

    # Verify
    assert await cache.get("key1") is None
    assert await cache.get("key2") is None
    assert await cache.get("key3") == "value3"


@pytest.mark.asyncio
async def test_keys_pattern(cache: CacheFn) -> None:
    """Test keys with pattern matching."""
    await cache.set("user:1", "Alice")
    await cache.set("user:2", "Bob")
    await cache.set("post:1", "Post 1")

    # Get all keys
    all_keys = await cache.keys()
    assert len(all_keys) == 3

    # Get keys by pattern
    user_keys = await cache.keys("user:*")
    assert len(user_keys) == 2
    assert "user:1" in user_keys
    assert "user:2" in user_keys


@pytest.mark.asyncio
async def test_get_or_fetch(cache: CacheFn) -> None:
    """Test get_or_fetch pattern."""
    fetch_count = 0

    async def fetcher():
        nonlocal fetch_count
        fetch_count += 1
        return "fetched_value"

    # First call - should fetch
    value = await cache.get_or_fetch("key1", fetcher)
    assert value == "fetched_value"
    assert fetch_count == 1

    # Second call - should use cache
    value = await cache.get_or_fetch("key1", fetcher)
    assert value == "fetched_value"
    assert fetch_count == 1


@pytest.mark.asyncio
async def test_invalidate_by_pattern(cache: CacheFn) -> None:
    """Test pattern-based invalidation."""
    await cache.set("user:1", "Alice")
    await cache.set("user:2", "Bob")
    await cache.set("post:1", "Post 1")

    # Invalidate users
    await cache.invalidate_by_pattern("user:*")

    # Check results
    assert await cache.get("user:1") is None
    assert await cache.get("user:2") is None
    assert await cache.get("post:1") == "Post 1"


@pytest.mark.asyncio
async def test_lru_eviction() -> None:
    """Test LRU eviction when max_size is reached."""
    cache = cache_fn(name="lru-test", max_size=3)

    # Fill cache
    await cache.set("key1", "value1")
    await cache.set("key2", "value2")
    await cache.set("key3", "value3")

    # All keys should exist
    assert await cache.size() == 3

    # Add one more - should evict key1 (least recently used)
    await cache.set("key4", "value4")

    # Check eviction
    assert await cache.size() == 3
    assert await cache.get("key1") is None
    assert await cache.get("key4") == "value4"


@pytest.mark.asyncio
async def test_namespace(cache: CacheFn) -> None:
    """Test namespace isolation."""
    cache1 = cache_fn(name="test", namespace="ns1")
    cache2 = cache_fn(name="test", namespace="ns2")

    await cache1.set("key1", "value1")
    await cache2.set("key1", "value2")

    # Should be isolated
    value1 = await cache1.get("key1")
    value2 = await cache2.get("key1")

    assert value1 == "value1"
    assert value2 == "value2"


@pytest.mark.asyncio
async def test_stats(cache: CacheFn) -> None:
    """Test statistics tracking."""
    # Perform operations
    await cache.set("key1", "value1")
    await cache.get("key1")  # hit
    await cache.get("key2")  # miss
    await cache.get("key1")  # hit
    await cache.delete("key1")

    # Get stats
    stats = await cache.get_stats()

    assert stats.hits == 2
    assert stats.misses == 1
    assert stats.sets == 1
    assert stats.deletes == 1
    assert stats.hit_rate > 0


@pytest.mark.asyncio
async def test_events(cache: CacheFn) -> None:
    """Test event emission."""
    events = []

    cache.on("hit", lambda event: events.append(("hit", event)))
    cache.on("miss", lambda event: events.append(("miss", event)))
    cache.on("set", lambda event: events.append(("set", event)))

    await cache.set("key1", "value1")
    await cache.get("key1")
    await cache.get("key2")

    # Check events
    assert len(events) == 3
    assert events[0][0] == "set"
    assert events[1][0] == "hit"
    assert events[2][0] == "miss"


@pytest.mark.asyncio
async def test_entries(cache: CacheFn) -> None:
    """Test entries retrieval."""
    await cache.set("user:1", {"name": "Alice"})
    await cache.set("user:2", {"name": "Bob"})
    await cache.set("post:1", {"title": "Post 1"})

    # Get all entries
    all_entries = await cache.entries()
    assert len(all_entries) == 3

    # Get entries by pattern
    user_entries = await cache.entries(pattern="user:*")
    assert len(user_entries) == 2

    # Get with limit
    limited_entries = await cache.entries(limit=2)
    assert len(limited_entries) == 2
