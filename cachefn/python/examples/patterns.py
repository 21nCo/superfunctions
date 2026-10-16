"""
Common caching patterns with CacheFn.
"""

import asyncio
import random
from cachefn import cache_fn


# Simulated database
fake_db = {
    "user:1": {"id": "1", "name": "Alice", "email": "alice@example.com"},
    "user:2": {"id": "2", "name": "Bob", "email": "bob@example.com"},
    "user:3": {"id": "3", "name": "Charlie", "email": "charlie@example.com"},
}


async def fetch_from_database(key: str):
    """Simulate database fetch with latency."""
    print(f"  Fetching {key} from database...")
    await asyncio.sleep(0.5)  # Simulate DB latency
    return fake_db.get(key)


async def cache_aside_pattern():
    """Demonstrate cache-aside (lazy loading) pattern."""
    print("=== Cache-Aside Pattern ===")

    cache = cache_fn(name="cache-aside", max_size=100)

    async def get_user(user_id: str):
        """Get user with cache-aside pattern."""
        key = f"user:{user_id}"

        # Try cache first
        cached = await cache.get(key)
        if cached:
            print(f"✓ Cache hit: {key}")
            return cached

        # Cache miss - fetch from database
        print(f"✗ Cache miss: {key}")
        user = await fetch_from_database(key)

        # Store in cache
        if user:
            await cache.set(key, user, ttl=300000)  # 5 minutes

        return user

    # First call - cache miss
    user = await get_user("1")
    print(f"  Result: {user}\n")

    # Second call - cache hit
    user = await get_user("1")
    print(f"  Result: {user}\n")


async def read_through_pattern():
    """Demonstrate read-through pattern."""
    print("=== Read-Through Pattern (using get_or_fetch) ===")

    cache = cache_fn(name="read-through", max_size=100)

    # Read-through with get_or_fetch
    user = await cache.get_or_fetch(
        "user:1",
        fetcher=lambda: fetch_from_database("user:1"),
        ttl=300000,
        tags=["users"],
    )
    print(f"✓ First fetch: {user}\n")

    # Second call - from cache
    user = await cache.get_or_fetch(
        "user:1",
        fetcher=lambda: fetch_from_database("user:1"),
        ttl=300000,
        tags=["users"],
    )
    print(f"✓ Second fetch (cached): {user}\n")


async def write_through_pattern():
    """Demonstrate write-through pattern."""
    print("=== Write-Through Pattern ===")

    cache = cache_fn(name="write-through", max_size=100)

    async def save_user(user_id: str, user_data: dict):
        """Save user to database and cache simultaneously."""
        key = f"user:{user_id}"

        # Write to database
        print(f"  Writing {key} to database...")
        await asyncio.sleep(0.1)  # Simulate DB write
        fake_db[key] = user_data

        # Write to cache
        await cache.set(key, user_data, ttl=300000)
        print(f"✓ Saved {key} to both database and cache")

    # Save new user
    new_user = {"id": "4", "name": "Diana", "email": "diana@example.com"}
    await save_user("4", new_user)

    # Read from cache (instant)
    cached_user = await cache.get("user:4")
    print(f"✓ Read from cache: {cached_user}\n")


async def cache_warming_pattern():
    """Demonstrate cache warming pattern."""
    print("=== Cache Warming Pattern ===")

    cache = cache_fn(name="cache-warming", max_size=100)

    async def warm_cache(user_ids: list[str]):
        """Pre-load cache with user data."""
        print(f"Warming cache with {len(user_ids)} users...")

        entries = []
        for user_id in user_ids:
            key = f"user:{user_id}"
            user = await fetch_from_database(key)
            if user:
                entries.append({"key": key, "value": user, "ttl": 300000})

        await cache.set_many(entries)
        print(f"✓ Warmed cache with {len(entries)} users\n")

    # Warm cache on startup
    await warm_cache(["1", "2", "3"])

    # Fast reads from cache
    user = await cache.get("user:1")
    print(f"✓ Fast read after warming: {user}\n")


async def tiered_invalidation_pattern():
    """Demonstrate tiered invalidation with tags."""
    print("=== Tiered Invalidation Pattern ===")

    cache = cache_fn(name="tiered-invalidation", max_size=100)

    # Set data with hierarchical tags
    await cache.set(
        "user:1:profile",
        {"name": "Alice"},
        tags=["users", "user:1", "profiles"],
    )
    await cache.set(
        "user:1:settings",
        {"theme": "dark"},
        tags=["users", "user:1", "settings"],
    )
    await cache.set(
        "user:2:profile",
        {"name": "Bob"},
        tags=["users", "user:2", "profiles"],
    )

    print("✓ Set user data with hierarchical tags\n")

    # Invalidate all profiles
    print("Invalidating all profiles...")
    await cache.invalidate_by_tag("profiles")
    profile = await cache.get("user:1:profile")
    settings = await cache.get("user:1:settings")
    print(f"  user:1:profile after invalidation: {profile}")
    print(f"  user:1:settings after invalidation: {settings}\n")

    # Invalidate specific user
    await cache.set(
        "user:1:profile",
        {"name": "Alice"},
        tags=["users", "user:1", "profiles"],
    )
    print("Invalidating user:1...")
    await cache.invalidate_by_tag("user:1")
    profile1 = await cache.get("user:1:profile")
    profile2 = await cache.get("user:2:profile")
    print(f"  user:1:profile after invalidation: {profile1}")
    print(f"  user:2:profile after invalidation: {profile2}\n")


async def rate_limiting_pattern():
    """Demonstrate rate limiting with cache."""
    print("=== Rate Limiting Pattern ===")

    cache = cache_fn(name="rate-limiting", max_size=1000)

    async def check_rate_limit(user_id: str, max_requests: int = 5, window_ms: int = 10000):
        """Check if user is within rate limit."""
        key = f"ratelimit:{user_id}"

        # Get current count
        current = await cache.get(key) or 0

        if current >= max_requests:
            return False  # Rate limit exceeded

        # Increment count
        await cache.set(key, current + 1, ttl=window_ms)
        return True

    # Simulate requests
    user_id = "user:123"
    print(f"Simulating requests from {user_id} (max 5 per 10 seconds):\n")

    for i in range(7):
        allowed = await check_rate_limit(user_id)
        status = "✓ Allowed" if allowed else "✗ Rate limited"
        print(f"  Request {i + 1}: {status}")

    print()


async def main() -> None:
    """Run all pattern examples."""
    await cache_aside_pattern()
    await read_through_pattern()
    await write_through_pattern()
    await cache_warming_pattern()
    await tiered_invalidation_pattern()
    await rate_limiting_pattern()

    print("✓ All pattern examples completed!")


if __name__ == "__main__":
    asyncio.run(main())
