/**
 * Function memoization examples
 */

import { memoize, memoizeSync } from "../src/index.js";

// Example 1: Fibonacci with memoization
function example1() {
  console.log("=== Example 1: Fibonacci with Memoization ===");

  const fibonacci = memoizeSync(
    (n: number): number => {
      if (n <= 1) return n;
      return fibonacci(n - 1) + fibonacci(n - 2);
    },
    {
      keyGenerator: (n) => `fib:${n}`,
      maxSize: 1000,
    }
  );

  console.time("First call");
  console.log("fib(40):", fibonacci(40));
  console.timeEnd("First call");

  console.time("Second call (cached)");
  console.log("fib(40):", fibonacci(40));
  console.timeEnd("Second call (cached)");
}

// Example 2: Async API call memoization
async function example2() {
  console.log("\n=== Example 2: Async API Call Memoization ===");

  let callCount = 0;

  const fetchUser = memoize(
    async (userId: string) => {
      callCount++;
      console.log(`Fetching user ${userId} from API...`);
      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { id: userId, name: `User ${userId}` };
    },
    {
      keyGenerator: (userId) => `api:user:${userId}`,
      ttl: 60000,
    }
  );

  // First call - fetches from API
  await fetchUser("123");
  console.log("API calls:", callCount);

  // Second call - returns from cache
  await fetchUser("123");
  console.log("API calls:", callCount);

  // Different user - fetches from API
  await fetchUser("456");
  console.log("API calls:", callCount);
}

// Example 3: Expensive computation
async function example3() {
  console.log("\n=== Example 3: Expensive Computation ===");

  const computeHash = memoize(
    async (data: string) => {
      console.log("Computing hash...");
      // Simulate expensive computation
      await new Promise((resolve) => setTimeout(resolve, 500));
      return data.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    },
    {
      ttl: 300000, // 5 minutes
    }
  );

  console.time("First computation");
  await computeHash("hello world");
  console.timeEnd("First computation");

  console.time("Second computation (cached)");
  await computeHash("hello world");
  console.timeEnd("Second computation (cached)");
}

// Example 4: Cache control methods
async function example4() {
  console.log("\n=== Example 4: Cache Control Methods ===");

  const expensiveOp = memoize(async (x: number, y: number) => {
    console.log(`Computing ${x} + ${y}...`);
    return x + y;
  });

  await expensiveOp(1, 2);
  await expensiveOp(3, 4);

  const stats = await expensiveOp.stats();
  console.log("Stats before clear:", stats);

  // Clear specific entry
  await expensiveOp.delete(1, 2);

  // Clear all cached results
  await expensiveOp.clear();

  const statsAfter = await expensiveOp.stats();
  console.log("Stats after clear:", statsAfter);
}

// Example 5: Custom key generator
async function example5() {
  console.log("\n=== Example 5: Custom Key Generator ===");

  interface SearchOptions {
    query: string;
    filters?: Record<string, any>;
    page?: number;
  }

  const search = memoize(
    async (options: SearchOptions) => {
      console.log("Performing search:", options);
      return { results: [], total: 0 };
    },
    {
      keyGenerator: (options) => {
        // Custom key that ignores page for caching
        const { query, filters } = options;
        return `search:${query}:${JSON.stringify(filters || {})}`;
      },
      ttl: 120000,
    }
  );

  // These will use the same cache entry
  await search({ query: "test", page: 1 });
  await search({ query: "test", page: 2 }); // Cached!

  // Different query - new cache entry
  await search({ query: "other", page: 1 });
}

// Example 6: Conditional memoization
async function example6() {
  console.log("\n=== Example 6: Conditional Memoization ===");

  interface FetchOptions {
    url: string;
    skipCache?: boolean;
  }

  let fetchCount = 0;

  const fetchData = async (options: FetchOptions) => {
    // Manual cache check for conditional caching
    if (options.skipCache) {
      fetchCount++;
      console.log("Skipping cache, fetching fresh data...");
      return { data: "fresh" };
    }

    // Use memoized version
    return memoizedFetch(options);
  };

  const memoizedFetch = memoize(async (options: FetchOptions) => {
    fetchCount++;
    console.log("Fetching data...");
    return { data: "cached" };
  });

  await fetchData({ url: "/api/data" });
  console.log("Fetch count:", fetchCount);

  await fetchData({ url: "/api/data" }); // Cached
  console.log("Fetch count:", fetchCount);

  await fetchData({ url: "/api/data", skipCache: true }); // Fresh
  console.log("Fetch count:", fetchCount);
}

// Run all examples
async function main() {
  example1();
  await example2();
  await example3();
  await example4();
  await example5();
  await example6();
}

main().catch(console.error);
