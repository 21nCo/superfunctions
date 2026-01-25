"""
Tests for rate limiter
"""

import pytest
import asyncio
from browsefn.core.rate_limiter import RateLimiter
from browsefn.core.types import RateLimitConfig


@pytest.mark.asyncio
async def test_rate_limiter_basic():
    """Test basic rate limiting"""
    config = RateLimitConfig(requests=2, window=1000)
    limiter = RateLimiter(global_config=config)
    
    # First two requests should pass
    assert await limiter.check_limit('test') == True
    assert await limiter.check_limit('test') == True
    
    # Third should fail
    assert await limiter.check_limit('test') == False


@pytest.mark.asyncio
async def test_rate_limiter_window_reset():
    """Test rate limit window reset"""
    config = RateLimitConfig(requests=2, window=100)  # 100ms window
    limiter = RateLimiter(global_config=config)
    
    # Use up limit
    await limiter.check_limit('test')
    await limiter.check_limit('test')
    
    assert await limiter.check_limit('test') == False
    
    # Wait for window to expire
    await asyncio.sleep(0.15)
    
    # Should be allowed again
    assert await limiter.check_limit('test') == True


@pytest.mark.asyncio
async def test_rate_limiter_per_provider():
    """Test per-provider rate limits"""
    provider_config = {
        'fast': RateLimitConfig(requests=10, window=1000),
        'slow': RateLimitConfig(requests=2, window=1000)
    }
    limiter = RateLimiter(per_provider_configs=provider_config)
    
    # Fast provider should allow more
    for _ in range(5):
        assert await limiter.check_limit('fast') == True
    
    # Slow provider should be limited
    assert await limiter.check_limit('slow') == True
    assert await limiter.check_limit('slow') == True
    assert await limiter.check_limit('slow') == False


@pytest.mark.asyncio
async def test_rate_limiter_status():
    """Test getting rate limit status"""
    config = RateLimitConfig(requests=5, window=1000)
    limiter = RateLimiter(global_config=config)
    
    await limiter.check_limit('test')
    await limiter.check_limit('test')
    
    status = limiter.get_status('test')
    
    assert status.limit == 5
    assert status.remaining == 3
    assert status.reset_at > 0


@pytest.mark.asyncio
async def test_rate_limiter_reset():
    """Test resetting rate limits"""
    config = RateLimitConfig(requests=2, window=1000)
    limiter = RateLimiter(global_config=config)
    
    await limiter.check_limit('test')
    await limiter.check_limit('test')
    
    assert await limiter.check_limit('test') == False
    
    limiter.reset('test')
    
    # Should be allowed again after reset
    assert await limiter.check_limit('test') == True


@pytest.mark.asyncio
async def test_rate_limiter_wait():
    """Test waiting for rate limit"""
    config = RateLimitConfig(requests=1, window=200)
    limiter = RateLimiter(global_config=config)
    
    await limiter.check_limit('test')
    
    # This should wait until window resets
    start = asyncio.get_event_loop().time()
    await limiter.wait_for_limit('test')
    duration = asyncio.get_event_loop().time() - start
    
    # Should have waited approximately 200ms
    assert duration >= 0.15  # Allow some variance
    assert await limiter.check_limit('test') == True
