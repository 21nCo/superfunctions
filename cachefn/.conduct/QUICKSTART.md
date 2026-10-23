# CacheFn Python SDK - Quick Start Guide

Get started with CacheFn in under 5 minutes!

## Installation

```bash
pip install cachefn
```

Or install from source:

```bash
cd cachefn/python
pip install -e .
```

## Your First Cache

```python
from cachefn import cache_fn
import asyncio

async def main():
    # Create a cache
    cache = cache_fn(name="my-cache", max_size=100)
    
    # Store a value
    await cache.set("greeting", "Hello, World!")
    
    # Retrieve it
    greeting = await cache.get("greeting")
    print(greeting)  # "Hello, World!"

asyncio.run(main())
```

## Memoize a Function

Cache expensive function results automatically:

```python
from cachefn import memoize
import asyncio

@memoize(ttl=60000)  # Cache for 60 seconds
async def fetch_user(user_id: str):
    print(f"Fetching user {user_id}...")
    # Simulate expensive operation
    await asyncio.sleep(1)
    return {"id": user_id, "name": "Alice"}

async def main():
    # First call - slow (1 second)
    user = await fetch_user("123")
    
    # Second call - instant (cached!)
    user = await fetch_user("123")

asyncio.run(main())
```

## Common Patterns

### Cache with TTL

```python
# Cache for 5 minutes
await cache.set("session:abc", session_data, ttl=300000)
```

### Tag-Based Invalidation

```python
# Set with tags
await cache.set("user:1", user1, tags=["users", "active"])
await cache.set("user:2", user2, tags=["users", "active"])

# Invalidate all users
await cache.invalidate_by_tag("users")
```

### Cache-Aside Pattern

```python
# Get from cache or fetch from database
user = await cache.get_or_fetch(
    f"user:{user_id}",
    fetcher=lambda: db.get_user(user_id),
    ttl=300000,
    tags=["users"]
)
```

### Pattern Matching

```python
# Get all user keys
user_keys = await cache.keys("user:*")

# Invalidate by pattern
await cache.invalidate_by_pattern("session:*")
```

## Monitor Cache Performance

```python
# Get statistics
stats = await cache.get_stats()
print(f"Hit rate: {stats.hit_rate:.2f}%")
print(f"Total hits: {stats.hits}")
print(f"Total misses: {stats.misses}")
print(f"Cache size: {stats.size} entries")
```

## Listen to Events

```python
# Register event handlers
cache.on("hit", lambda event: print(f"Cache hit: {event.key}"))
cache.on("miss", lambda event: print(f"Cache miss: {event.key}"))
cache.on("eviction", lambda event: print(f"Evicted: {event.key}"))

# Perform operations - events will fire
await cache.set("key", "value")
await cache.get("key")  # Triggers "hit" event
```

## Synchronous Memoization

For non-async functions:

```python
from cachefn import memoize_sync

@memoize_sync(max_size=1000)
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

# Compute fibonacci(40) instantly with memoization
result = fibonacci(40)
```

## More Examples

Check out the `examples/` directory for:
- `basic_usage.py` - Comprehensive cache operations
- `memoization.py` - Memoization patterns
- `patterns.py` - Common caching patterns (rate limiting, cache warming, etc.)

## Configuration Options

```python
cache = cache_fn(
    name="my-cache",          # Unique cache name (required)
    storage="memory",         # Storage backend (default: "memory")
    max_size=1000,           # Maximum entries (default: None)
    default_ttl=60000,       # Default TTL in ms (default: None)
    namespace="app"          # Key namespace (default: None)
)
```

## Next Steps

- Read the [full documentation](README.md)
- Explore [examples](examples/)
- Check out [common patterns](examples/patterns.py)
- Review the [API reference](README.md#api-reference)

## Need Help?

- GitHub Issues: https://github.com/21nCo/super-functions/issues
- Documentation: https://docs.superfunctions.dev/cachefn

Happy caching! 🚀
