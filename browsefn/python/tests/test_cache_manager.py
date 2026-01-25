"""
Tests for cache manager
"""

import pytest
import asyncio
from browsefn.core.cache_manager import CacheManager
from browsefn.core.types import CacheConfig


@pytest.mark.asyncio
async def test_cache_set_and_get():
    """Test basic cache set and get"""
    config = CacheConfig(enabled=True, ttl=60000)
    cache = CacheManager(config)
    
    await cache.set('test', 'https://example.com', {'data': 'test'})
    result = await cache.get('test', 'https://example.com')
    
    assert result == {'data': 'test'}


@pytest.mark.asyncio
async def test_cache_expiration():
    """Test cache expiration with TTL"""
    config = CacheConfig(enabled=True, ttl=100)  # 100ms TTL
    cache = CacheManager(config)
    
    await cache.set('test', 'https://example.com', 'data')
    
    # Should be available immediately
    result = await cache.get('test', 'https://example.com')
    assert result == 'data'
    
    # Wait for expiration
    await asyncio.sleep(0.15)
    
    # Should be expired
    result = await cache.get('test', 'https://example.com')
    assert result is None


@pytest.mark.asyncio
async def test_cache_lru_eviction():
    """Test LRU eviction when max size reached"""
    config = CacheConfig(enabled=True, ttl=60000, max_size=2)
    cache = CacheManager(config)
    
    await cache.set('test', 'url1', 'data1')
    await cache.set('test', 'url2', 'data2')
    await cache.set('test', 'url3', 'data3')  # Should evict url1
    
    assert await cache.get('test', 'url1') is None
    assert await cache.get('test', 'url2') == 'data2'
    assert await cache.get('test', 'url3') == 'data3'


@pytest.mark.asyncio
async def test_cache_invalidation():
    """Test cache invalidation by pattern"""
    config = CacheConfig(enabled=True, ttl=60000)
    cache = CacheManager(config)
    
    await cache.set('test', 'https://example.com/page1', 'data1')
    await cache.set('test', 'https://example.com/page2', 'data2')
    await cache.set('test', 'https://other.com/page1', 'data3')
    
    await cache.invalidate('example.com')
    
    assert await cache.get('test', 'https://example.com/page1') is None
    assert await cache.get('test', 'https://example.com/page2') is None
    assert await cache.get('test', 'https://other.com/page1') == 'data3'


@pytest.mark.asyncio
async def test_cache_stats():
    """Test cache statistics tracking"""
    config = CacheConfig(enabled=True, ttl=60000)
    cache = CacheManager(config)
    
    await cache.set('test', 'url1', 'data1')
    
    # Cache hit
    await cache.get('test', 'url1')
    
    # Cache miss
    await cache.get('test', 'url2')
    
    stats = await cache.get_stats()
    
    assert stats.hits == 1
    assert stats.misses == 1
    assert stats.hit_rate == 50.0
    assert stats.size == 1


@pytest.mark.asyncio
async def test_cache_clear():
    """Test clearing all cache"""
    config = CacheConfig(enabled=True, ttl=60000)
    cache = CacheManager(config)
    
    await cache.set('test', 'url1', 'data1')
    await cache.set('test', 'url2', 'data2')
    
    await cache.clear()
    
    stats = await cache.get_stats()
    assert stats.size == 0
    assert stats.hits == 0
    assert stats.misses == 0


@pytest.mark.asyncio
async def test_cache_disabled():
    """Test cache when disabled"""
    config = CacheConfig(enabled=False)
    cache = CacheManager(config)
    
    await cache.set('test', 'url1', 'data1')
    result = await cache.get('test', 'url1')
    
    assert result is None
