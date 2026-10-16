"""Tests for the Python rate limiter."""

from pathlib import Path
import sys
import asyncio

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browsefn.core.errors import BrowseFnError
from browsefn.core.rate_limiter import RateLimiter
from browsefn.core.types import RateLimitConfig


@pytest.mark.asyncio
async def test_rate_limiter_enforces_global_and_provider_limits():
    limiter = RateLimiter(
        global_config=RateLimitConfig(requests=2, window=1000),
        per_provider_configs={"unsplash": RateLimitConfig(requests=1, window=1000)},
    )

    assert await limiter.check_limit("unsplash") is True
    assert await limiter.check_limit("unsplash") is False


@pytest.mark.asyncio
async def test_rate_limiter_window_reset():
    limiter = RateLimiter(global_config=RateLimitConfig(requests=1, window=100))

    assert await limiter.check_limit("test") is True
    assert await limiter.check_limit("test") is False

    await asyncio.sleep(0.15)

    assert await limiter.check_limit("test") is True


@pytest.mark.asyncio
async def test_rate_limiter_exposes_status_and_error():
    limiter = RateLimiter(global_config=RateLimitConfig(requests=1, window=1000))

    assert await limiter.check_limit("pixabay") is True
    status = limiter.get_status("pixabay")

    assert status.limit == 1
    assert status.remaining == 0
    assert status.reset_at > 0

    with pytest.raises(BrowseFnError, match="Rate limit exceeded for provider pixabay."):
        await limiter.enforce("pixabay")


@pytest.mark.asyncio
async def test_rate_limiter_reset_clears_provider_limit():
    limiter = RateLimiter(
        per_provider_configs={"pexels": RateLimitConfig(requests=1, window=1000)}
    )

    assert await limiter.check_limit("pexels") is True
    assert await limiter.check_limit("pexels") is False

    limiter.reset("pexels")

    assert await limiter.check_limit("pexels") is True


@pytest.mark.asyncio
async def test_rate_limiter_waits_until_window_resets():
    limiter = RateLimiter(global_config=RateLimitConfig(requests=1, window=100))

    assert await limiter.check_limit("mapbox") is True

    start = asyncio.get_event_loop().time()
    await limiter.wait_for_limit("mapbox")
    duration = asyncio.get_event_loop().time() - start

    assert duration >= 0.09
