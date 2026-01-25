"""
Cache manager for storing and retrieving responses
"""

from typing import Any, Dict, Optional, Callable
from datetime import datetime
from pydantic import BaseModel
from browsefn.core.types import CacheConfig


class CacheEntry(BaseModel):
    data: Any
    timestamp: float
    ttl: int
    
    class Config:
        arbitrary_types_allowed = True


class CacheStats(BaseModel):
    hits: int
    misses: int
    hit_rate: float
    size: int


class CacheManager:
    """Manager for caching responses with TTL and size limits"""
    
    def __init__(self, config: CacheConfig):
        self.config = config
        self.cache: Dict[str, CacheEntry] = {}
        self.hits = 0
        self.misses = 0
    
    def _generate_key(self, method: str, url: str, options: Any = None) -> str:
        """Generate cache key from method, url, and options"""
        # Use custom key generator if provided
        if hasattr(self.config, 'key_generator') and self.config.key_generator:
            return self.config.key_generator(method, url, options)
        
        # Default key generation
        import json
        options_str = json.dumps(options, sort_keys=True) if options else ""
        return f"{method}:{url}:{options_str}"
    
    async def get(self, method: str, url: str, options: Any = None) -> Optional[Any]:
        """Get cached value if exists and not expired"""
        if not self.config.enabled:
            return None
        
        key = self._generate_key(method, url, options)
        entry = self.cache.get(key)
        
        if not entry:
            self.misses += 1
            return None
        
        # Check if expired
        now = datetime.now().timestamp() * 1000  # milliseconds
        if now - entry.timestamp > entry.ttl:
            del self.cache[key]
            self.misses += 1
            return None
        
        self.hits += 1
        return entry.data
    
    async def set(self, method: str, url: str, data: Any, options: Any = None) -> None:
        """Set cached value with TTL"""
        if not self.config.enabled:
            return
        
        key = self._generate_key(method, url, options)
        ttl = self.config.ttl or 3600000  # 1 hour default in milliseconds
        
        # Check max size and evict oldest if needed
        if self.config.max_size and len(self.cache) >= self.config.max_size:
            # Remove oldest entry (first in dict)
            if self.cache:
                first_key = next(iter(self.cache))
                del self.cache[first_key]
        
        self.cache[key] = CacheEntry(
            data=data,
            timestamp=datetime.now().timestamp() * 1000,
            ttl=ttl
        )
    
    async def invalidate(self, url_or_pattern: str) -> None:
        """Invalidate cache entries matching URL or pattern"""
        keys_to_delete = [
            key for key in self.cache.keys()
            if url_or_pattern in key
        ]
        
        for key in keys_to_delete:
            del self.cache[key]
    
    async def clear(self) -> None:
        """Clear all cache"""
        self.cache.clear()
        self.hits = 0
        self.misses = 0
    
    async def get_stats(self) -> CacheStats:
        """Get cache statistics"""
        total = self.hits + self.misses
        hit_rate = (self.hits / total * 100) if total > 0 else 0.0
        
        return CacheStats(
            hits=self.hits,
            misses=self.misses,
            hit_rate=hit_rate,
            size=len(self.cache)
        )
    
    def has(self, method: str, url: str, options: Any = None) -> bool:
        """Check if key exists and is valid"""
        if not self.config.enabled:
            return False
        
        key = self._generate_key(method, url, options)
        entry = self.cache.get(key)
        
        if not entry:
            return False
        
        # Check if expired
        now = datetime.now().timestamp() * 1000
        if now - entry.timestamp > entry.ttl:
            del self.cache[key]
            return False
        
        return True
