import asyncio

import pytest

from cachefn import cache_fn, memoize, memoize_sync
from cachefn.core.types import CacheEvent, EvictionEvent


@pytest.mark.asyncio
async def test_none_is_a_cached_hit_and_enumerated() -> None:
    cache = cache_fn("none")
    await cache.set("key", None)
    assert await cache.get_or_fetch("key", lambda: pytest.fail("must not fetch")) is None
    assert await cache.entries() == [{"key": "key", "value": None}]
    assert await cache.entries(limit=0) == []
    stats = await cache.get_stats()
    assert stats.hits == 2
    assert stats.misses == 0


@pytest.mark.asyncio
async def test_overwrite_removes_old_tags() -> None:
    cache = cache_fn("tags")
    await cache.set("key", 1, tags=["old"])
    await cache.set("key", 2, tags=["new"])
    await cache.invalidate_by_tag("old")
    assert await cache.get("key") == 2
    await cache.invalidate_by_tag("new")
    assert not await cache.has("key")


@pytest.mark.asyncio
async def test_expired_entries_do_not_evict_live_values_or_appear_in_size() -> None:
    cache = cache_fn("expiration", max_size=2)
    await cache.set("live", 1)
    await cache.set("expired", 2, ttl=0)
    await cache.set("new", 3)
    assert await cache.keys() == ["live", "new"]
    assert await cache.size() == 2
    assert (await cache.get_stats()).evictions == 0


@pytest.mark.asyncio
async def test_single_flight_survives_cancelled_waiter_and_caches_none() -> None:
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0

    @memoize()
    async def compute() -> None:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return None

    first = asyncio.create_task(compute())
    await started.wait()
    second = asyncio.create_task(compute())
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert await second is None
    assert await compute() is None
    assert calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["delete", "clear", "write", "pattern"])
async def test_pending_fill_cannot_undo_invalidation(operation: str) -> None:
    cache = cache_fn("invalidation")
    started, release = asyncio.Event(), asyncio.Event()

    async def fetch() -> str:
        started.set()
        await release.wait()
        return "old"

    waiter = asyncio.create_task(cache.get_or_fetch("key", fetch))
    await started.wait()
    if operation == "delete":
        await cache.delete("key")
    elif operation == "clear":
        await cache.clear()
    elif operation == "pattern":
        await cache.invalidate_by_pattern("k*")
    else:
        await cache.set("key", "new")
    release.set()
    assert await waiter == "old"
    assert await cache.get("key") == ("new" if operation == "write" else None)


@pytest.mark.asyncio
async def test_failed_fill_retries_and_accepts_sync_fetcher() -> None:
    cache = cache_fn("retry")

    def fail() -> None:
        raise ValueError("failure")

    with pytest.raises(ValueError, match="failure"):
        await cache.get_or_fetch("key", fail)
    assert await cache.get_or_fetch("key", lambda: 42) == 42


def test_sync_lru_expiration_and_statistics(monkeypatch: pytest.MonkeyPatch) -> None:
    from importlib import import_module

    module = import_module("cachefn.memoization.memoize")
    now = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: now[0])
    calls = []

    @memoize_sync(max_size=2, ttl=1000)
    def compute(key: str) -> None:
        calls.append(key)
        return None

    compute("a")
    compute("b")
    compute("a")
    compute("c")
    compute("a")
    assert calls == ["a", "b", "c"]
    assert compute.stats()["hits"] == 2
    assert compute.stats()["evictions"] == 1
    now[0] = 1.0
    assert compute.stats()["size"] == 0
    compute("a")
    assert calls == ["a", "b", "c", "a"]
    compute.clear()
    assert compute.stats()["misses"] == 0


@pytest.mark.parametrize("size", [0, -1])
def test_invalid_capacities(size: int) -> None:
    with pytest.raises(ValueError):
        cache_fn("bad", max_size=size)
    with pytest.raises(ValueError):
        memoize(max_size=size)(lambda: 1)
    with pytest.raises(ValueError):
        memoize_sync(max_size=size)(lambda: 1)


@pytest.mark.asyncio
async def test_tag_invalidation_supersedes_pending_fill() -> None:
    cache = cache_fn("tag-fill")
    started, release = asyncio.Event(), asyncio.Event()

    async def fetch() -> int:
        started.set()
        await release.wait()
        return 1

    task = asyncio.create_task(cache.get_or_fetch("key", fetch, tags=["group"]))
    await started.wait()
    await cache.invalidate_by_tag("group")
    release.set()
    assert await task == 1
    assert not await cache.has("key")


def test_memoization_keys_preserve_types_and_fail_on_unsupported_values() -> None:
    from cachefn import hash_value

    assert hash_value([1]) != hash_value((1,))
    assert hash_value({1: "a"}) != hash_value({"1": "a"})
    assert hash_value({1, 2}) == hash_value({2, 1})
    assert hash_value({"a": 1, "b": 2}) == hash_value({"b": 2, "a": 1})
    assert hash_value(b"a") != hash_value("a")
    with pytest.raises(TypeError, match="key_generator"):
        hash_value(object())
    circular: list[object] = []
    circular.append(circular)
    with pytest.raises(ValueError, match="Circular"):
        hash_value(circular)


def test_event_removal_during_emit_does_not_skip_other_handlers() -> None:
    from cachefn.core.events import EventEmitter

    events = EventEmitter()
    received = []

    def first(value: int) -> None:
        events.off("hit", first)
        received.append(("first", value))

    events.on("hit", first)
    events.on("hit", lambda value: received.append(("second", value)))
    events.emit("hit", 1)
    events.off("hit", first)
    assert received == [("first", 1), ("second", 1)]


@pytest.mark.asyncio
async def test_eviction_event_identifies_the_removed_key() -> None:
    cache = cache_fn("eviction", max_size=1, namespace="scope")
    evicted: list[CacheEvent] = []
    cache.on("eviction", evicted.append)
    await cache.set("first", 1)
    await cache.set("second", 2)
    assert isinstance(evicted[0], EvictionEvent)
    assert evicted[0].key == "scope:first"
    assert evicted[0].reason == "lru"
