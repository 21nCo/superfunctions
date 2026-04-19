"""Cache manager for storing and retrieving responses."""

import json
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
    ttl: int
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

    async def get(self, method: str, url: str, options: Any = None) -> Optional[Any]:
        """Get cached value if it exists and has not expired."""
        if not self.config.enabled:
            return None

        key = self._generate_key(method, url, options)
        entry = self.cache.get(key)

        if not entry:
            self.misses += 1
            return None

        now = datetime.now().timestamp() * 1000  # milliseconds
        if now - entry.timestamp > entry.ttl:
            del self.cache[key]
            self.misses += 1
            return None

        self.cache.move_to_end(key)
        self.hits += 1
        return entry.data

    async def set(self, method: str, url: str, data: Any, options: Any = None) -> None:
        """Set cached value with TTL."""
        if not self.config.enabled:
            return

        key = self._generate_key(method, url, options)
        ttl = self.config.ttl or 3600000  # 1 hour default in milliseconds

        if self.config.max_size and len(self.cache) >= self.config.max_size:
            self.cache.popitem(last=False)

        self.cache[key] = CacheEntry(
            data=data,
            timestamp=datetime.now().timestamp() * 1000,
            ttl=ttl
        )
        self.cache.move_to_end(key)

    async def invalidate(self, url_or_pattern: str) -> None:
        """Invalidate cache entries matching URL or pattern."""
        keys_to_delete = [
            key for key in self.cache.keys()
            if url_or_pattern in key
        ]
        
        for key in keys_to_delete:
            del self.cache[key]
    
    async def clear(self) -> None:
        """Clear all cache entries and stats."""
        self.cache.clear()
        self.hits = 0
        self.misses = 0

    async def get_stats(self) -> CacheStats:
        """Get cache statistics."""
        total = self.hits + self.misses
        hit_rate = (self.hits / total * 100) if total > 0 else 0.0

        return CacheStats(
            hits=self.hits,
            misses=self.misses,
            hit_rate=hit_rate,
            size=len(self.cache)
        )

    def has(self, method: str, url: str, options: Any = None) -> bool:
        """Check if a normalized key exists and is still valid."""
        if not self.config.enabled:
            return False

        key = self._generate_key(method, url, options)
        entry = self.cache.get(key)

        if not entry:
            return False

        now = datetime.now().timestamp() * 1000
        if now - entry.timestamp > entry.ttl:
            del self.cache[key]
            return False

        self.cache.move_to_end(key)
        return True
