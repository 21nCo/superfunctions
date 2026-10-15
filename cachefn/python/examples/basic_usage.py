"""
Basic usage examples for CacheFn.
"""

import asyncio
from cachefn import cache_fn


async def main() -> None:
    """Demonstrate basic cache operations."""
    # Create a cache instance
    cache = cache_fn(
        name="my-cache",
        storage="memory",
        max_size=1000,
        default_ttl=60000,  # 1 minute
    )

    print("=== Basic Operations ===")

    # Set a value
    await cache.set("user:123", {"name": "Alice", "age": 30})
    print("✓ Set user:123")

    # Get a value
    user = await cache.get("user:123")
    print(f"✓ Get user:123: {user}")

    # Check if key exists
    exists = await cache.has("user:123")
    print(f"✓ Has user:123: {exists}")

    # Delete a key
    deleted = await cache.delete("user:123")
    print(f"✓ Deleted user:123: {deleted}")

    # Verify deletion
    user = await cache.get("user:123")
    print(f"✓ Get user:123 after delete: {user}")

    print("\n=== Batch Operations ===")

    # Set multiple values
    await cache.set_many(
        [
            {"key": "user:1", "value": {"name": "Alice"}},
            {"key": "user:2", "value": {"name": "Bob"}},
            {"key": "user:3", "value": {"name": "Charlie"}},
        ]
    )
    print("✓ Set multiple users")

    # Get multiple values
    users = await cache.get_many(["user:1", "user:2", "user:3"])
    print(f"✓ Get multiple users: {users}")

    print("\n=== TTL and Tags ===")

    # Set with TTL and tags
    await cache.set(
        "session:abc",
        {"user_id": "123", "token": "xyz"},
        ttl=5000,  # 5 seconds
        tags=["sessions", "user:123"],
    )
    print("✓ Set session with TTL and tags")

    # Wait and check expiration
    print("Waiting 6 seconds for TTL expiration...")
    await asyncio.sleep(6)

    session = await cache.get("session:abc")
    print(f"✓ Get session after TTL: {session}")

    print("\n=== Tag-Based Invalidation ===")

    # Set multiple entries with tags
    await cache.set("post:1", {"title": "Post 1"}, tags=["posts", "user:123"])
    await cache.set("post:2", {"title": "Post 2"}, tags=["posts", "user:456"])
    await cache.set("post:3", {"title": "Post 3"}, tags=["posts", "user:123"])
    print("✓ Set posts with tags")

    # Invalidate by tag
    await cache.invalidate_by_tag("posts")
    print("✓ Invalidated posts tag")

    # Verify invalidation
    post1 = await cache.get("post:1")
    post2 = await cache.get("post:2")
    print(f"✓ Posts after invalidation: {post1}, {post2}")

    print("\n=== Pattern Matching ===")

    # Set multiple entries
    await cache.set("user:1", {"name": "Alice"})
    await cache.set("user:2", {"name": "Bob"})
    await cache.set("post:1", {"title": "Post 1"})
    print("✓ Set mixed entries")

    # Get keys by pattern
    user_keys = await cache.keys("user:*")
    print(f"✓ User keys: {user_keys}")

    all_keys = await cache.keys()
    print(f"✓ All keys: {all_keys}")

    # Invalidate by pattern
    await cache.invalidate_by_pattern("user:*")
    print("✓ Invalidated user:* pattern")

    remaining_keys = await cache.keys()
    print(f"✓ Remaining keys: {remaining_keys}")

    print("\n=== Statistics ===")

    # Perform some operations
    await cache.set("key1", "value1")
    await cache.get("key1")
    await cache.get("key2")  # miss
    await cache.get("key1")  # hit

    # Get stats
    stats = await cache.get_stats()
    print(f"✓ Hits: {stats.hits}")
    print(f"✓ Misses: {stats.misses}")
    print(f"✓ Hit Rate: {stats.hit_rate:.2f}%")
    print(f"✓ Size: {stats.size}")
    print(f"✓ Memory Usage: {stats.memory_usage} bytes")

    print("\n=== Events ===")

    # Register event handlers
    cache.on("hit", lambda event: print(f"  Event: Hit {event.key}"))
    cache.on("miss", lambda event: print(f"  Event: Miss {event.key}"))
    cache.on("set", lambda event: print(f"  Event: Set {event.key}"))

    await cache.set("event:test", "value")
    await cache.get("event:test")
    await cache.get("event:missing")

    print("\n✓ All examples completed!")


if __name__ == "__main__":
    asyncio.run(main())
