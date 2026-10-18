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
async def test_cache_invalidation_and_stats_are_backend_agnostic(tmp_path):
    config = CacheConfig(enabled=True, ttl=60000, storage="file", directory=str(tmp_path))
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

@pytest.mark.asyncio
async def test_file_persistence_models_binary_and_namespaces(tmp_path):
    from browsefn.core.types import PageResult, PageMetadata
    config = CacheConfig(enabled=True, storage='file', directory=str(tmp_path), name='one')
    first = CacheManager(config)
    value = PageResult(url='https://example.com', content='ok', metadata=PageMetadata(url='https://example.com'), screenshot=b'\x00\xff', provider='cheerio')
    await first.set('web', 'https://example.com', value)
    second = CacheManager(config)
    result = await second.get('web', 'https://example.com')
    assert isinstance(result, PageResult)
    assert result.screenshot == b'\x00\xff'
    assert await second.has_async('web', 'https://example.com')
    with pytest.raises(RuntimeError, match='has_async'):
        second.has('web', 'https://example.com')
    other = CacheManager(CacheConfig(enabled=True, storage='file', directory=str(tmp_path), name='one:child'))
    await other.set('web', 'https://example.com', 'other')
    await second.clear()
    assert await first.get('web', 'https://example.com') is None
    assert await other.get('web', 'https://example.com') == 'other'


@pytest.mark.asyncio
async def test_file_concurrent_managers_and_failed_write_preserve_values(tmp_path):
    config = CacheConfig(enabled=True, storage='file', directory=str(tmp_path))
    a, b = CacheManager(config), CacheManager(config)
    await asyncio.gather(*( (a if i % 2 else b).set('web', f'url{i}', i) for i in range(12)))
    assert (await a.get_stats()).size == 12
    with pytest.raises(TypeError):
        await a.set('web', 'url0', lambda: None)
    assert await b.get('web', 'url0') == 0


@pytest.mark.asyncio
async def test_replacement_and_ttl_boundaries(monkeypatch):
    from datetime import datetime
    from browsefn.core import cache_manager
    class Clock:
        now_ms = 1000
        @classmethod
        def now(cls):
            return datetime.fromtimestamp(cls.now_ms / 1000)
    monkeypatch.setattr(cache_manager, 'datetime', Clock)
    cache = CacheManager(CacheConfig(enabled=True, ttl=10, maxSize=2))
    await cache.set('web', 'a', 1)
    await cache.set('web', 'b', 2)
    await cache.set('web', 'b', 3)
    assert await cache.get('web', 'a') == 1
    Clock.now_ms += 10
    assert not cache.has('web', 'a')
    assert (await cache.get_stats()).size == 0
    for ttl in [0, -1, float('inf'), float('nan')]:
        with pytest.raises(BrowseFnError):
            await cache.set('web', 'b', 1, {'cache': {'ttl': ttl}})
    await cache.set('web', 'c', 3, {'cache': {'ttl': 2}})
    Clock.now_ms += 2
    assert await cache.get('web', 'c', {'cache': {'ttl': 2}}) is None


@pytest.mark.asyncio
async def test_database_real_sqlite_persistence_and_rollback(tmp_path):
    from sqlalchemy import Column, Integer, MetaData, String, Table, Text, create_engine
    from superfunctions_sqlalchemy import create_adapter
    engine = create_engine('sqlite+pysqlite:///' + str(tmp_path / 'cache.sqlite'), isolation_level='SERIALIZABLE')
    metadata = MetaData()
    schema = CacheManager.database_schema()
    assert schema.name == 'browsefn_cache'
    Table(schema.name, metadata, Column('id', String, primary_key=True), Column('value', Text, nullable=False), Column('revision', Integer, nullable=False))
    metadata.create_all(engine)
    try:
        config = CacheConfig(enabled=True, storage='database', database=create_adapter(engine))
        a, b = CacheManager(config), CacheManager(config)
        await a.set('web', 'url', {'bytes': b'\x00\xff', 'tuple': (1, 2)})
        assert await b.get('web', 'url') == {'bytes': b'\x00\xff', 'tuple': (1, 2)}
        with pytest.raises(TypeError):
            await a.set('web', 'url', object())
        assert await b.get('web', 'url') == {'bytes': b'\x00\xff', 'tuple': (1, 2)}
        await b.invalidate('url')
        assert not await a.has_async('web', 'url')
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_indexeddb_bridge_commits_serialized_state():
    class Bridge:
        def __init__(self):
            self.values = {}
            self.lock = asyncio.Lock()
        async def transaction(self, name, callback):
            async with self.lock:
                raw, result = callback(self.values.get(name))
                self.values[name] = raw
                return result
    bridge = Bridge()
    options = CacheConfig(enabled=True, storage='indexeddb', backend=bridge)
    await CacheManager(options).set('web', 'url', b'bytes')
    assert await CacheManager(options).get('web', 'url') == b'bytes'
    with pytest.raises(ValueError, match='backend'):
        CacheManager(CacheConfig(enabled=True, storage='indexeddb'))

@pytest.mark.asyncio
async def test_cache_values_are_detached_from_callers():
    cache = CacheManager(CacheConfig(enabled=True))
    value = {'items': [1]}
    await cache.set('web', 'url', value)
    value['items'].append(2)
    returned = await cache.get('web', 'url')
    returned['items'].append(3)
    assert await cache.get('web', 'url') == {'items': [1]}
