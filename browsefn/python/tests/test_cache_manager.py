"""Tests for the Python cache manager."""

from pathlib import Path
import sys
import asyncio

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browsefn.core.cache_manager import CacheManager
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import CacheConfig


@pytest.mark.asyncio
async def test_cache_set_and_get():
    config = CacheConfig(enabled=True, ttl=60000)
    cache = CacheManager(config)

    await cache.set("web.get_page", "https://example.com", {"data": "test"})
    result = await cache.get("web.get_page", "https://example.com")

    assert result == {"data": "test"}


@pytest.mark.asyncio
async def test_cache_expiration():
    config = CacheConfig(enabled=True, ttl=100)
    cache = CacheManager(config)

    await cache.set("web.get_page", "https://example.com", "data")
    assert await cache.get("web.get_page", "https://example.com") == "data"

    await asyncio.sleep(0.15)

    assert await cache.get("web.get_page", "https://example.com") is None


@pytest.mark.asyncio
async def test_cache_evicts_least_recently_used_entry():
    config = CacheConfig(enabled=True, ttl=60000, max_size=2)
    cache = CacheManager(config)

    await cache.set("web.get_page", "url1", "data1")
    await cache.set("web.get_page", "url2", "data2")
    assert await cache.get("web.get_page", "url1") == "data1"

    await cache.set("web.get_page", "url3", "data3")

    assert await cache.get("web.get_page", "url2") is None
    assert await cache.get("web.get_page", "url1") == "data1"
    assert await cache.get("web.get_page", "url3") == "data3"


@pytest.mark.asyncio
async def test_cache_normalizes_aliases_and_provider_ids():
    config = CacheConfig(enabled=True, defaultTTL=60000, maxSize=10, storage="memory")
    cache = CacheManager(config)

    await cache.set(
        "web.get_page",
        "example.com#fragment",
        "normalized",
        {"provider": "googleMaps"},
    )

    result = await cache.get(
        "web.get_page",
        "https://example.com",
        {"provider": "google-maps"},
    )

    assert config.ttl == 60000
    assert config.max_size == 10
    assert result == "normalized"


@pytest.mark.asyncio
async def test_cache_invalidation_and_stats_are_backend_agnostic():
    config = CacheConfig(enabled=True, ttl=60000, storage="file")
    cache = CacheManager(config)

    await cache.set("web.get_page", "https://example.com/page1", "data1")
    await cache.set("web.get_page", "https://example.com/page2", "data2")
    await cache.set("web.get_page", "https://other.com/page1", "data3")

    await cache.get("web.get_page", "https://other.com/page1")
    await cache.get("web.get_page", "https://missing.com/page")
    await cache.invalidate("example.com")

    assert await cache.get("web.get_page", "https://example.com/page1") is None
    assert await cache.get("web.get_page", "https://example.com/page2") is None
    assert await cache.get("web.get_page", "https://other.com/page1") == "data3"

    stats = await cache.get_stats()
    assert stats.hits == 2
    assert stats.misses == 3
    assert stats.size == 1
    assert stats.hit_rate == 40.0


def test_cache_rejects_unsupported_storage():
    config = CacheConfig(enabled=True, storage="redis")

    with pytest.raises(BrowseFnError, match="Unsupported cache storage: redis"):
        CacheManager(config)
