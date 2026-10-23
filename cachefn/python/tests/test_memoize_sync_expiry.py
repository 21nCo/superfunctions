"""Expiration scheduling must preserve synchronous cache semantics at populated sizes."""

from collections import OrderedDict
from importlib import import_module
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from cachefn import memoize_sync

module = import_module("cachefn.memoization.memoize")


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    value = [100.0]
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: value[0]))
    return value


@pytest.mark.parametrize("ttl", [None, 1000])
def test_populated_hits_do_not_iterate_unexpired_entries(clock: list[float], ttl: int | None) -> None:
    cached = memoize_sync(max_size=10000, ttl=ttl, key_generator=str)(lambda value: value)
    for key in range(10000):
        cached(key)

    class CountedEntries(OrderedDict[str, tuple[Any, float | None]]):
        pass

    entries = CountedEntries(cached._cache)
    cached._cache = entries
    with patch.object(entries, "items", wraps=entries.items) as scans:
        for key in range(100):
            assert cached(key) == key
        scans.assert_not_called()
        assert cached.stats()["size"] == 10000
        scans.assert_not_called()


def test_expiration_boundary_is_not_extended_by_hits(clock: list[float]) -> None:
    calls = []

    @memoize_sync(ttl=1000)
    def cached(value: str) -> int:
        calls.append(value)
        return len(calls)

    assert cached("a") == 1
    clock[0] = 100.999
    assert cached("a") == 1
    clock[0] = 101.0
    assert cached("a") == 2
    assert cached.stats()["size"] == 1


def test_ttl_starts_when_computation_finishes(clock: list[float]) -> None:
    @memoize_sync(ttl=1000)
    def cached() -> float:
        clock[0] += 10
        return clock[0]

    assert cached() == 110
    clock[0] = 110.9
    assert cached() == 110
    clock[0] = 111
    assert cached() == 121


def test_expired_entries_are_removed_before_capacity_eviction(clock: list[float]) -> None:
    calls = []

    @memoize_sync(max_size=2, ttl=1000)
    def cached(key: str) -> str:
        calls.append(key)
        return key

    cached("old")
    clock[0] = 100.5
    cached("live")
    cached("old")  # Touching changes LRU order, not expiration.
    clock[0] = 101
    cached("new")
    assert cached("live") == "live"
    assert calls == ["old", "live", "new"]
    assert cached.stats()["evictions"] == 0
    assert cached.stats()["size"] == 2


def test_lru_eviction_still_tracks_recent_hits(clock: list[float]) -> None:
    calls = []

    @memoize_sync(max_size=2, ttl=1000)
    def cached(key: str) -> str:
        calls.append(key)
        return key

    cached("a")
    cached("b")
    cached("a")
    cached("c")
    cached("b")
    assert calls == ["a", "b", "c", "b"]
    assert cached.stats()["evictions"] == 2


def test_delete_and_clear_do_not_keep_expired_values_or_stale_sizes(clock: list[float]) -> None:
    cached = memoize_sync(ttl=1000)(lambda key: key)
    cached("old")
    clock[0] = 100.5
    cached("later")
    cached.delete("old")
    clock[0] = 101
    assert cached.stats()["size"] == 1
    clock[0] = 101.5
    assert cached.stats()["size"] == 0
    cached("new")
    cached.clear()
    assert cached.stats()["size"] == 0
    assert cached.stats()["hits"] == 0
    assert cached("new") == "new"


def test_zero_ttl_and_falsy_results(clock: list[float]) -> None:
    calls = []

    @memoize_sync(ttl=0)
    def immediate() -> None:
        calls.append(1)
        return None

    assert immediate() is None
    assert immediate() is None
    assert len(calls) == 2
    assert immediate.stats()["size"] == 0
    permanent = memoize_sync()(lambda: False)
    assert permanent() is False
    clock[0] += 100000
    assert permanent() is False
    assert permanent.stats()["hits"] == 1


def test_exception_is_not_cached_and_does_not_evict_live_results(clock: list[float]) -> None:
    fail = [True]

    @memoize_sync(max_size=1, ttl=1000)
    def cached(key: str) -> str:
        if key == "bad" and fail[0]:
            raise ValueError("retry")
        return key

    cached("live")
    with pytest.raises(ValueError, match="retry"):
        cached("bad")
    assert cached("live") == "live"
    assert cached.stats()["evictions"] == 0
    fail[0] = False
    assert cached("bad") == "bad"


def test_reentrant_computation_preserves_completion_ttl_and_capacity(clock: list[float]) -> None:
    @memoize_sync(max_size=1, ttl=1000)
    def cached(key: str) -> str:
        if key == "outer":
            assert cached("inner") == "inner"
            clock[0] += 0.5
        return key

    assert cached("outer") == "outer"
    assert cached.stats()["size"] == 1
    clock[0] = 101.0  # The evicted inner entry's old expiration cannot expire outer.
    assert cached("outer") == "outer"
    clock[0] = 101.5
    assert cached.stats()["size"] == 0
