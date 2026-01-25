# Getting Started with CacheFn Python SDK

Welcome! This guide will help you get up and running with CacheFn in minutes.

## Prerequisites

- Python 3.10 or higher
- pip package manager

## Installation

### From PyPI (when published)

```bash
pip install cachefn
```

### From Source

```bash
cd cachefn/python
pip install -e .
```

### With Development Dependencies

```bash
pip install -e ".[dev]"
```

## Verify Installation

```bash
python -c "from cachefn import cache_fn; print('CacheFn installed successfully!')"
```

## Quick Start

### 1. Create Your First Cache

Create a file called `my_cache.py`:

```python
from cachefn import cache_fn
import asyncio

async def main():
    # Create a cache instance
    cache = cache_fn(
        name="my-first-cache",
        max_size=100,           # Store up to 100 items
        default_ttl=60000       # Items expire after 60 seconds
    )
    
    # Store a value
    await cache.set("greeting", "Hello, CacheFn!")
    
    # Retrieve the value
    greeting = await cache.get("greeting")
    print(f"Retrieved: {greeting}")
    
    # Check if a key exists
    exists = await cache.has("greeting")
    print(f"Key exists: {exists}")
    
    # Get cache statistics
    stats = await cache.get_stats()
    print(f"Cache size: {stats.size} items")
    print(f"Hit rate: {stats.hit_rate:.2f}%")

if __name__ == "__main__":
    asyncio.run(main())
```

Run it:

```bash
python my_cache.py
```

### 2. Memoize a Function

Create `memoize_demo.py`:

```python
from cachefn import memoize
import asyncio
import time

@memoize(ttl=60000)  # Cache results for 60 seconds
async def expensive_calculation(x: int, y: int) -> int:
    """Simulate an expensive operation."""
    print(f"Computing {x} + {y}...")
    await asyncio.sleep(1)  # Simulate work
    return x + y

async def main():
    # First call - will compute (slow)
    start = time.time()
    result = await expensive_calculation(10, 20)
    print(f"Result: {result}, Time: {time.time() - start:.2f}s")
    
    # Second call - from cache (fast!)
    start = time.time()
    result = await expensive_calculation(10, 20)
    print(f"Result: {result}, Time: {time.time() - start:.4f}s")

if __name__ == "__main__":
    asyncio.run(main())
```

Run it:

```bash
python memoize_demo.py
```

### 3. Use Cache-Aside Pattern

Create `cache_aside.py`:

```python
from cachefn import cache_fn
import asyncio

# Simulated database
users_db = {
    "user:1": {"id": "1", "name": "Alice"},
    "user:2": {"id": "2", "name": "Bob"},
}

async def fetch_user_from_db(user_id: str):
    """Simulate database fetch."""
    print(f"Fetching user {user_id} from database...")
    await asyncio.sleep(0.5)  # Simulate DB latency
    return users_db.get(f"user:{user_id}")

async def main():
    cache = cache_fn(name="users", max_size=100)
    
    # Get user with cache-aside pattern
    user = await cache.get_or_fetch(
        "user:1",
        fetcher=lambda: fetch_user_from_db("1"),
        ttl=300000,  # Cache for 5 minutes
        tags=["users"]
    )
    print(f"First fetch: {user}")
    
    # Second call - from cache (no DB call!)
    user = await cache.get_or_fetch(
        "user:1",
        fetcher=lambda: fetch_user_from_db("1"),
        ttl=300000,
        tags=["users"]
    )
    print(f"Second fetch: {user}")

if __name__ == "__main__":
    asyncio.run(main())
```

## Common Use Cases

### Rate Limiting

```python
from cachefn import cache_fn

cache = cache_fn(name="rate-limiter")

async def check_rate_limit(user_id: str, max_requests: int = 10):
    key = f"ratelimit:{user_id}"
    current = await cache.get(key) or 0
    
    if current >= max_requests:
        return False  # Rate limit exceeded
    
    await cache.set(key, current + 1, ttl=60000)  # 1 minute window
    return True
```

### Session Caching

```python
from cachefn import cache_fn

session_cache = cache_fn(name="sessions", default_ttl=3600000)  # 1 hour

async def store_session(session_id: str, user_data: dict):
    await session_cache.set(
        f"session:{session_id}",
        user_data,
        tags=["sessions", f"user:{user_data['id']}"]
    )

async def get_session(session_id: str):
    return await session_cache.get(f"session:{session_id}")
```

### Cache Warming

```python
async def warm_cache():
    """Pre-load frequently accessed data."""
    cache = cache_fn(name="products")
    
    popular_products = await db.get_popular_products()
    
    entries = [
        {
            "key": f"product:{p['id']}",
            "value": p,
            "ttl": 600000  # 10 minutes
        }
        for p in popular_products
    ]
    
    await cache.set_many(entries)
    print(f"Warmed cache with {len(entries)} products")
```

## Next Steps

### 1. Explore Examples

Check out the `examples/` directory:

```bash
cd cachefn/python/examples

# Run basic usage examples
python basic_usage.py

# Try memoization examples
python memoization.py

# Explore common patterns
python patterns.py
```

### 2. Read the Documentation

- [README.md](README.md) - Complete API reference
- [QUICKSTART.md](QUICKSTART.md) - Quick reference guide
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) - Technical details

### 3. Run the Tests

```bash
# Install dev dependencies
make install

# Run tests
make test

# Run with coverage
make test-cov
```

### 4. Integrate with Your App

Here's a minimal FastAPI example (FastAPI middleware coming in V0.2):

```python
from fastapi import FastAPI
from cachefn import cache_fn, memoize

app = FastAPI()
cache = cache_fn(name="api-cache")

@memoize(ttl=60000, tags=["users"])
async def get_user_data(user_id: str):
    # Fetch from database
    return await db.users.get(user_id)

@app.get("/users/{user_id}")
async def read_user(user_id: str):
    user = await get_user_data(user_id)
    return user

@app.post("/users/{user_id}/invalidate")
async def invalidate_user(user_id: str):
    await get_user_data.cache.invalidate_by_tag("users")
    return {"status": "invalidated"}
```

## Configuration Tips

### For Development

```python
cache = cache_fn(
    name="dev-cache",
    max_size=100,          # Small size for testing
    default_ttl=10000      # Short TTL (10 seconds)
)
```

### For Production

```python
cache = cache_fn(
    name="prod-cache",
    max_size=10000,        # Larger cache
    default_ttl=300000,    # Longer TTL (5 minutes)
    namespace="app"        # Namespace for isolation
)
```

## Troubleshooting

### Issue: Values Not Being Cached

Check that you're using `await`:

```python
# ❌ Wrong
cache.set("key", "value")

# ✅ Correct
await cache.set("key", "value")
```

### Issue: Cache Growing Too Large

Set a max_size:

```python
cache = cache_fn(name="cache", max_size=1000)  # Limit to 1000 items
```

### Issue: Values Expiring Too Fast

Adjust TTL:

```python
# Longer TTL
await cache.set("key", "value", ttl=3600000)  # 1 hour

# Or set default TTL
cache = cache_fn(name="cache", default_ttl=3600000)
```

## Need Help?

- **Issues**: https://github.com/21nCo/super-functions/issues
- **Docs**: https://docs.superfunctions.dev/cachefn
- **Examples**: Check the `examples/` directory
- **Tests**: Look at `tests/` for usage patterns

## What's Next?

- Learn about [tag-based invalidation](README.md#invalidation)
- Explore [pattern matching](README.md#pattern-matching)
- Set up [event monitoring](README.md#events)
- Try [advanced patterns](examples/patterns.py)

Happy caching! 🎉
