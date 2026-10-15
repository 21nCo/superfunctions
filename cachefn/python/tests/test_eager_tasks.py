"""Cache-aside ownership must survive Python 3.12 eager task scheduling."""

import asyncio

import pytest

from cachefn import cache_fn


@pytest.mark.skipif(not hasattr(asyncio, "eager_task_factory"), reason="Requires Python 3.12")
@pytest.mark.asyncio
async def test_eager_factory_stores_results_and_expires_them():
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    loop.set_task_factory(asyncio.eager_task_factory)
    try:
        cache = cache_fn("eager")
        assert await cache.get_or_fetch("key", lambda: "first") == "first"
        assert await cache.has("key")
        assert not cache._pending
        assert await cache.get_or_fetch("key", lambda: "unexpected") == "first"
        assert await cache.get_or_fetch("expired", lambda: "old", ttl=0) == "old"
        assert not await cache.has("expired")
        assert await cache.get_or_fetch("expired", lambda: "fresh") == "fresh"
    finally:
        loop.set_task_factory(previous)


@pytest.mark.skipif(not hasattr(asyncio, "eager_task_factory"), reason="Requires Python 3.12")
@pytest.mark.asyncio
async def test_eager_factory_does_not_retain_failures():
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    loop.set_task_factory(asyncio.eager_task_factory)
    try:
        cache = cache_fn("eager-failure")

        async def fail():
            raise ValueError("failure")

        with pytest.raises(ValueError, match="failure"):
            await cache.get_or_fetch("key", fail)
        assert not cache._pending
        assert await cache.get_or_fetch("key", lambda: "recovered") == "recovered"
    finally:
        loop.set_task_factory(previous)


@pytest.mark.skipif(not hasattr(asyncio, "eager_task_factory"), reason="Requires Python 3.12")
@pytest.mark.asyncio
async def test_eager_factory_invalidation_supersedes_pending_fill():
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    loop.set_task_factory(asyncio.eager_task_factory)
    try:
        cache = cache_fn("eager-invalidation")
        task = asyncio.create_task(cache.get_or_fetch("key", lambda: "old", tags=["tag"]))
        await cache.invalidate_by_tag("tag")
        assert await task == "old"
        assert not await cache.has("key")
        assert not cache._pending
    finally:
        loop.set_task_factory(previous)
