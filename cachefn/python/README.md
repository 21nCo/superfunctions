# CacheFn Python SDK

> Self-hosted caching solution for Python applications

CacheFn is a developer-first caching library that provides memory caching, function memoization, and tag-based invalidation with zero external dependencies.

## Status

- **Version**: 0.1.0 (V0)
- **Python**: ✅ Complete (Memory storage)
- **TypeScript SDK**: ✅ Complete

## Features

✅ **Zero Dependencies** - No Redis, Memcached, or external services required  
✅ **Memory Storage** - In-memory cache with LRU eviction  
✅ **Type-Safe** - Full type hints with Pydantic models  
✅ **Function Memoization** - Cache expensive function results  
✅ **Tag-based Invalidation** - Flexible cache invalidation strategies  
✅ **Analytics** - Built-in hit/miss tracking and statistics  
✅ **Async First** - Built for modern async Python applications

## Installation

```bash
pip install cachefn
```

Or install from source:

```bash
cd cachefn/python
pip install -e .
```

## Quick Start

### Basic Usage

```python
from cachefn import cache_fn
import asyncio

async def main():
    # Create a cache instance
    cache = cache_fn(
        name="my-cache",
        storage="memory",
        max_size=1000,
        default_ttl=60000,  # 1 minute
    )

    # Set a value
    await cache.set("user:123", {"name": "Alice", "age": 30})

    # Get a value
    user = await cache.get("user:123")
    print(user)  # {'name': 'Alice', 'age': 30}

    # Set with TTL and tags
    await cache.set(
        "session:abc",
        {"user_id": "123", "token": "xyz"},
        ttl=3600000,  # 1 hour
        tags=["sessions", "user:123"],
    )

    # Invalidate by tag
    await cache.invalidate_by_tag("sessions")

    # Get stats
    stats = await cache.get_stats()
    print(f"Hit rate: {stats.hit_rate:.2f}%")

if __name__ == "__main__":
    asyncio.run(main())
```

### Function Memoization

```python
from cachefn import memoize
import asyncio

@memoize(ttl=60000, max_size=500)
async def expensive_operation(user_id: str):
    """This function's results will be cached."""
    # Simulate expensive operation
    await asyncio.sleep(1)
    return {"user_id": user_id, "data": "expensive result"}

async def main():
    # First call - takes 1 second
    result = await expensive_operation("123")
    
    # Second call - instant (cached)
    result = await expensive_operation("123")
    
    # Clear cache for this function
    await expensive_operation.clear()

if __name__ == "__main__":
    asyncio.run(main())
```

### Synchronous Memoization

```python
from cachefn import memoize_sync

@memoize_sync(max_size=1000)
def fibonacci(n: int) -> int:
    """Memoized fibonacci function."""
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

# Fast computation due to memoization
print(fibonacci(100))
```

### Cache-Aside Pattern

```python
from cachefn import cache_fn
import asyncio

async def fetch_user_from_db(user_id: str):
    """Simulate database fetch."""
    await asyncio.sleep(0.5)
    return {"id": user_id, "name": "Alice"}

async def main():
    cache = cache_fn(name="users", max_size=100)

    # Get or fetch pattern
    user = await cache.get_or_fetch(
        f"user:{user_id}",
        fetcher=lambda: fetch_user_from_db(user_id),
        ttl=300000,  # 5 minutes
        tags=["users"],
    )

if __name__ == "__main__":
    asyncio.run(main())
```

## API Reference

### CacheFn Class

#### Constructor

```python
cache_fn(
    name: str,
    storage: str = "memory",
    max_size: Optional[int] = None,
    default_ttl: Optional[int] = None,
    namespace: Optional[str] = None,
) -> CacheFn
```

#### Core Methods

- `async get(key: str) -> Optional[Any]` - Get a value from cache
- `async set(key: str, value: Any, ttl: Optional[int] = None, tags: Optional[list[str]] = None) -> None` - Set a value
- `async has(key: str) -> bool` - Check if key exists
- `async delete(key: str) -> bool` - Delete a key
- `async clear() -> None` - Clear all entries

#### Batch Operations

- `async get_many(keys: list[str]) -> list[Optional[Any]]` - Get multiple values
- `async set_many(entries: list[dict]) -> None` - Set multiple values
- `async delete_many(keys: list[str]) -> None` - Delete multiple keys

#### Utility Methods

- `async get_or_fetch(key, fetcher, ttl, tags) -> Any` - Cache-aside pattern
- `async keys(pattern: Optional[str]) -> list[str]` - Get keys matching pattern
- `async size() -> int` - Get number of entries
- `async entries(pattern, limit) -> list[dict]` - Get entries

#### Invalidation

- `async invalidate(key: str) -> bool` - Invalidate single key
- `async invalidate_by_tag(tag: str) -> None` - Invalidate by tag
- `async invalidate_by_tags(tags: list[str]) -> None` - Invalidate by multiple tags
- `async invalidate_by_pattern(pattern: str) -> None` - Invalidate by glob pattern

#### Analytics

- `async get_stats() -> CacheStats` - Get cache statistics
- `on(event: str, handler: Callable) -> None` - Register event handler
- `off(event: str, handler: Callable) -> None` - Unregister event handler

### Memoization

#### Async Memoization

```python
@memoize(
    ttl: Optional[int] = None,
    max_size: Optional[int] = None,
    storage: str = "memory",
    tags: Optional[list[str]] = None,
    key_generator: Optional[Callable] = None,
)
async def my_function(...):
    ...
```

#### Sync Memoization

```python
@memoize_sync(
    max_size: int = 1000,
    key_generator: Optional[Callable] = None,
)
def my_function(...):
    ...
```

## Events

CacheFn emits events for monitoring:

```python
cache = cache_fn(name="monitored")

cache.on("hit", lambda event: print(f"Cache hit: {event.key}"))
cache.on("miss", lambda event: print(f"Cache miss: {event.key}"))
cache.on("set", lambda event: print(f"Cache set: {event.key}"))
cache.on("delete", lambda event: print(f"Cache delete: {event.key}"))
cache.on("eviction", lambda event: print(f"Evicted: {event.key}"))
cache.on("invalidate", lambda event: print(f"Invalidated {event.count} keys"))
```

## Statistics

```python
stats = await cache.get_stats()

print(f"Hits: {stats.hits}")
print(f"Misses: {stats.misses}")
print(f"Hit Rate: {stats.hit_rate:.2f}%")
print(f"Size: {stats.size}")
print(f"Memory Usage: {stats.memory_usage} bytes")
```

## Integration with SuperFunctions

CacheFn integrates seamlessly with other superfunctions packages:

```python
from cachefn import cache_fn
# Future: from superfunctions.db import create_adapter

# Use with database adapter (coming soon)
cache = cache_fn(
    name="app-cache",
    storage="memory",  # Future: "db" with superfunctions adapter
)
```

## Examples

See the `examples/` directory for more examples:

- `basic_usage.py` - Basic cache operations
- `memoization.py` - Function memoization examples
- `patterns.py` - Common caching patterns

## Development

### Setup

```bash
cd cachefn/python
pip install -e ".[dev]"
```

### Run Tests

```bash
pytest
pytest --cov=cachefn
```

### Type Checking

```bash
mypy cachefn
```

### Linting

```bash
ruff check cachefn
black cachefn
```

## Architecture

```
cachefn/
├── core/
│   ├── cache.py          # Main CacheFn class
│   ├── types.py          # Type definitions
│   └── events.py         # Event emitter
├── storage/
│   └── memory_storage.py # Memory storage backend
├── memoization/
│   └── memoize.py        # Function memoization
├── analytics/
│   └── stats.py          # Statistics tracking
└── utils/
    ├── hash.py           # Key hashing
    ├── pattern.py        # Pattern matching
    ├── serialize.py      # Serialization
    └── ttl.py            # TTL utilities
```

## Roadmap

- [x] Memory storage with LRU eviction
- [x] Function memoization
- [x] Tag-based invalidation
- [x] Analytics and events
- [ ] IndexedDB-like storage (file-based)
- [ ] Integration with `superfunctions.db` adapters
- [ ] FastAPI middleware
- [ ] Flask middleware
- [ ] Compression support

## License

Apache-2.0

## Contributing

Contributions are welcome! Please see the main [superfunctions repository](https://github.com/21nCo/super-functions) for contribution guidelines.
