"""Cache manager for storing and retrieving responses."""

import json
import math
import copy
from collections import OrderedDict
from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict

from browsefn.core.errors import BrowseFnError
from browsefn.core.provider_registry import (
    normalize_geo_provider_id,
    normalize_image_provider_id,
    normalize_python_web_provider_id,
    normalize_web_provider_id,
)
from browsefn.core.types import CacheConfig
from browsefn.utils.url_utils import normalize_url


class CacheEntry(BaseModel):
    data: Any
    timestamp: float
    ttl: float
    model_config = ConfigDict(arbitrary_types_allowed=True)


class CacheStats(BaseModel):
    hits: int
    misses: int
    hit_rate: float
    size: int


class CacheManager:
    """Manager for caching responses with TTL and size limits."""

    SUPPORTED_STORAGES = {"memory", "indexeddb", "file", "database"}

    def __init__(self, config: CacheConfig):
        self.config = config
        self.storage = config.storage or "memory"
        if self.storage not in self.SUPPORTED_STORAGES:
            raise BrowseFnError(
                "INVALID_ARGUMENT",
                f"Unsupported cache storage: {self.storage}",
            )

        ttl = config.ttl if config.ttl is not None else 3600000
        if not math.isfinite(ttl) or ttl <= 0:
            raise BrowseFnError("INVALID_ARGUMENT", "Cache ttl must be greater than 0.")
        if config.max_size is not None and (isinstance(config.max_size, bool) or config.max_size <= 0):
            raise BrowseFnError("INVALID_ARGUMENT", "Cache maxSize must be a positive integer.")
        if not config.name.strip():
            raise BrowseFnError("INVALID_ARGUMENT", "Cache name must not be empty.")
        self._store = None
        from browsefn.core.cache_storage import FileCacheStore, DatabaseCacheStore, BridgeCacheStore
        if config.enabled and self.storage == 'file':
            self._store = FileCacheStore(config)
        elif config.enabled and self.storage == 'database':
            self._store = DatabaseCacheStore(config)
        elif config.enabled and self.storage == 'indexeddb':
            self._store = BridgeCacheStore(config)
        self.cache: "OrderedDict[str, CacheEntry]" = OrderedDict()
        self.hits = 0
        self.misses = 0

    def _normalize_options(self, value: Any) -> Any:
        if isinstance(value, dict):
            normalized: Dict[str, Any] = {}
            for key, item in value.items():
                if key == "provider" and isinstance(item, str):
                    normalized[key] = (
                        normalize_web_provider_id(item)
                        or normalize_python_web_provider_id(item)
                        or normalize_image_provider_id(item)
                        or normalize_geo_provider_id(item)
                        or item
                    )
                else:
                    normalized[key] = self._normalize_options(item)
            return normalized
        if isinstance(value, list):
            return [self._normalize_options(item) for item in value]
        return value

    def _generate_key(self, method: str, url: str, options: Any = None) -> str:
        """Generate a normalized cache key."""
        # Use custom key generator if provided
        if hasattr(self.config, 'key_generator') and self.config.key_generator:
            return self.config.key_generator(method, url, options)

        normalized_url = normalize_url(url)
        normalized_options = self._normalize_options(options)
        options_str = json.dumps(normalized_options, sort_keys=True, default=str) if options else ""
        return f"{method}:{normalized_url}:{options_str}"

    async def _run(self, operation):
        if self._store is not None:
            return await self._store.run(operation)
        return operation(self.cache)

    def _prune(self, entries):
        now = datetime.now().timestamp() * 1000
        for key, entry in list(entries.items()):
            if now - entry.timestamp >= entry.ttl:
                del entries[key]

    async def get(self, method: str, url: str, options: Any = None) -> Optional[Any]:
        if not self.config.enabled:
            return None
        key = self._generate_key(method, url, options)
        def operation(entries):
            self._prune(entries)
            entry = entries.get(key)
            if entry is not None:
                entries.move_to_end(key)
            return entry
        entry = await self._run(operation)
        if entry is None:
            self.misses += 1
            return None
        self.hits += 1
        return copy.deepcopy(entry.data)

    async def set(self, method: str, url: str, data: Any, options: Any = None) -> None:
        if not self.config.enabled:
            return
        key = self._generate_key(method, url, options)
        data = copy.deepcopy(data)
        ttl = self.config.ttl if self.config.ttl is not None else 3600000
        if isinstance(options, dict) and isinstance(options.get('cache'), dict):
            ttl = options['cache'].get('ttl', ttl)
        if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0:
            raise BrowseFnError("INVALID_ARGUMENT", "Cache ttl must be greater than 0.")
        def operation(entries):
            self._prune(entries)
            entries.pop(key, None)
            while self.config.max_size and len(entries) >= self.config.max_size:
                entries.popitem(last=False)
            entries[key] = CacheEntry(data=data, timestamp=datetime.now().timestamp() * 1000, ttl=ttl)
        await self._run(operation)

    async def invalidate(self, url_or_pattern: str) -> None:
        def operation(entries):
            for key in list(entries):
                if url_or_pattern in key:
                    del entries[key]
        await self._run(operation)

    async def clear(self) -> None:
        await self._run(lambda entries: entries.clear())
        self.hits = self.misses = 0

    async def get_stats(self) -> CacheStats:
        def operation(entries):
            self._prune(entries)
            return len(entries)
        size = await self._run(operation)
        total = self.hits + self.misses
        return CacheStats(hits=self.hits, misses=self.misses, hit_rate=self.hits / total * 100 if total else 0, size=size)

    def has(self, method: str, url: str, options: Any = None) -> bool:
        if not self.config.enabled:
            return False
        if self._store is not None:
            raise RuntimeError("Persistent cache presence requires await cache.has_async(...)")
        self._prune(self.cache)
        return self._generate_key(method, url, options) in self.cache

    async def has_async(self, method: str, url: str, options: Any = None) -> bool:
        if not self.config.enabled:
            return False
        def operation(entries):
            self._prune(entries)
            return self._generate_key(method, url, options) in entries
        return await self._run(operation)

    @staticmethod
    def database_schema():
        from browsefn.core.cache_storage import database_schema
        return database_schema()
