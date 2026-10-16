"""
Function memoization examples.
"""

import asyncio
import time
from cachefn import memoize, memoize_sync


# Async memoization example
@memoize(ttl=60000, max_size=500)
async def expensive_async_operation(user_id: str) -> dict:
    """Simulate an expensive async operation."""
    print(f"  Computing result for user {user_id}...")
    await asyncio.sleep(1)  # Simulate expensive operation
    return {"user_id": user_id, "data": "expensive result", "timestamp": time.time()}


# Sync memoization example
@memoize_sync(max_size=1000)
def fibonacci(n: int) -> int:
    """Compute fibonacci number with memoization."""
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)


@memoize_sync(max_size=100)
def factorial(n: int) -> int:
    """Compute factorial with memoization."""
    if n <= 1:
        return 1
    return n * factorial(n - 1)


async def main() -> None:
    """Demonstrate memoization examples."""
    print("=== Async Memoization ===")

    # First call - takes 1 second
    print("First call (will compute):")
    start = time.time()
    result = await expensive_async_operation("123")
    duration = time.time() - start
    print(f"  Result: {result}")
    print(f"  Duration: {duration:.2f}s")

    # Second call - instant (cached)
    print("\nSecond call (from cache):")
    start = time.time()
    result = await expensive_async_operation("123")
    duration = time.time() - start
    print(f"  Result: {result}")
    print(f"  Duration: {duration:.4f}s")

    # Different argument - computes again
    print("\nThird call with different argument:")
    start = time.time()
    result = await expensive_async_operation("456")
    duration = time.time() - start
    print(f"  Result: {result}")
    print(f"  Duration: {duration:.2f}s")

    # Get statistics
    stats = await expensive_async_operation.stats()
    print(f"\nCache stats: {stats.size} entries, {stats.hit_rate:.2f}% hit rate")

    # Clear cache
    await expensive_async_operation.clear()
    print("\n✓ Cache cleared")

    print("\n=== Sync Memoization - Fibonacci ===")

    # Compute large fibonacci number
    print("Computing fibonacci(40)...")
    start = time.time()
    result = fibonacci(40)
    duration = time.time() - start
    print(f"  Result: {result}")
    print(f"  Duration: {duration:.4f}s")

    # Second computation is instant
    print("\nComputing fibonacci(40) again (cached):")
    start = time.time()
    result = fibonacci(40)
    duration = time.time() - start
    print(f"  Result: {result}")
    print(f"  Duration: {duration:.6f}s")

    # Get cache stats
    stats = fibonacci.stats()
    print(f"\nFibonacci cache: {stats['size']} entries")

    print("\n=== Sync Memoization - Factorial ===")

    # Compute factorial
    print("Computing factorial(100)...")
    start = time.time()
    result = factorial(100)
    duration = time.time() - start
    print(f"  Result: {result}")
    print(f"  Duration: {duration:.6f}s")

    # Clear cache
    fibonacci.clear()
    factorial.clear()
    print("\n✓ Caches cleared")

    print("\n=== Custom Key Generator ===")

    @memoize(
        ttl=30000,
        key_generator=lambda user_id, include_metadata: f"user:{user_id}:meta={include_metadata}",
    )
    async def fetch_user(user_id: str, include_metadata: bool = False) -> dict:
        """Fetch user with custom cache key."""
        print(f"  Fetching user {user_id} (metadata={include_metadata})...")
        await asyncio.sleep(0.5)
        return {"id": user_id, "metadata": include_metadata}

    print("Fetching user with metadata=False:")
    result = await fetch_user("123", include_metadata=False)
    print(f"  Result: {result}")

    print("\nFetching user with metadata=True:")
    result = await fetch_user("123", include_metadata=True)
    print(f"  Result: {result}")

    print("\nFetching user with metadata=False again (cached):")
    result = await fetch_user("123", include_metadata=False)
    print(f"  Result: {result}")

    print("\n✓ All memoization examples completed!")


if __name__ == "__main__":
    asyncio.run(main())
