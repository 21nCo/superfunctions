/**
 * Basic CacheFn usage examples
 */

import { cacheFn, memoize } from "../src/index.js";

// Example 1: Simple memory cache
async function example1() {
  console.log("=== Example 1: Simple Memory Cache ===");

  const cache = cacheFn({
    name: "my-cache",
    storage: "memory",
    maxSize: 100,
    defaultTTL: 60000, // 1 minute
  });

  // Set a value
  await cache.set("user:123", { name: "Alice", age: 30 });

  // Get a value
  const user = await cache.get("user:123");
  console.log("User:", user);

  // Check if exists
  const exists = await cache.has("user:123");
  console.log("Exists:", exists);

  // Delete a value
  await cache.delete("user:123");
  console.log("After delete:", await cache.get("user:123"));
}

// Example 2: TTL-based expiration
async function example2() {
  console.log("\n=== Example 2: TTL-based Expiration ===");

  const cache = cacheFn({
    name: "ttl-cache",
    storage: "memory",
  });

  // Set with 2 second TTL
  await cache.set("session:abc", { token: "xyz" }, { ttl: 2000 });

  console.log("Immediately:", await cache.get("session:abc"));

  // Wait 3 seconds
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("After 3 seconds:", await cache.get("session:abc"));
}

// Example 3: Tag-based invalidation
async function example3() {
  console.log("\n=== Example 3: Tag-based Invalidation ===");

  const cache = cacheFn({
    name: "tag-cache",
    storage: "memory",
  });

  // Set multiple entries with tags
  await cache.set(
    "post:1",
    { title: "Post 1" },
    { tags: ["posts", "user:123"] }
  );
  await cache.set(
    "post:2",
    { title: "Post 2" },
    { tags: ["posts", "user:456"] }
  );
  await cache.set(
    "post:3",
    { title: "Post 3" },
    { tags: ["posts", "user:123"] }
  );

  console.log("Before invalidation:", await cache.size());

  // Invalidate all posts by user:123
  await cache.invalidateByTag("user:123");

  console.log("After invalidation:", await cache.size());
  console.log("Post 1:", await cache.get("post:1"));
  console.log("Post 2:", await cache.get("post:2"));
}

// Example 4: Pattern-based invalidation
async function example4() {
  console.log("\n=== Example 4: Pattern-based Invalidation ===");

  const cache = cacheFn({
    name: "pattern-cache",
    storage: "memory",
  });

  await cache.set("user:1", { name: "Alice" });
  await cache.set("user:2", { name: "Bob" });
  await cache.set("post:1", { title: "Post 1" });

  console.log("Before invalidation:", await cache.keys());

  // Invalidate all user keys
  await cache.invalidateByPattern("user:*");

  console.log("After invalidation:", await cache.keys());
}

// Example 5: Cache statistics
async function example5() {
  console.log("\n=== Example 5: Cache Statistics ===");

  const cache = cacheFn({
    name: "stats-cache",
    storage: "memory",
  });

  // Set some values
  await cache.set("key1", "value1");
  await cache.set("key2", "value2");

  // Generate some hits and misses
  await cache.get("key1"); // hit
  await cache.get("key1"); // hit
  await cache.get("key3"); // miss

  const stats = await cache.getStats();
  console.log("Stats:", stats);
}

// Example 6: getOrFetch pattern
async function example6() {
  console.log("\n=== Example 6: getOrFetch Pattern ===");

  const cache = cacheFn({
    name: "fetch-cache",
    storage: "memory",
  });

  let fetchCount = 0;

  const getUser = async (id: string) => {
    return await cache.getOrFetch(
      `user:${id}`,
      async () => {
        fetchCount++;
        console.log(`Fetching user ${id} from database...`);
        return { id, name: `User ${id}` };
      },
      { ttl: 60000 }
    );
  };

  // First call - fetches from database
  await getUser("123");
  console.log("Fetch count:", fetchCount);

  // Second call - returns from cache
  await getUser("123");
  console.log("Fetch count:", fetchCount);
}

// Example 7: Event listeners
async function example7() {
  console.log("\n=== Example 7: Event Listeners ===");

  const cache = cacheFn({
    name: "event-cache",
    storage: "memory",
    maxSize: 2,
  });

  cache.on("hit", (event) => {
    console.log(`Cache hit: ${event.key}`);
  });

  cache.on("miss", (event) => {
    console.log(`Cache miss: ${event.key}`);
  });

  cache.on("eviction", (event) => {
    console.log(`Evicted: ${event.key} (${event.reason})`);
  });

  await cache.set("key1", "value1");
  await cache.set("key2", "value2");

  await cache.get("key1"); // hit
  await cache.get("key3"); // miss

  // This will trigger eviction
  await cache.set("key3", "value3");
}

// Run all examples
async function main() {
  await example1();
  await example2();
  await example3();
  await example4();
  await example5();
  await example6();
  await example7();
}

main().catch(console.error);
