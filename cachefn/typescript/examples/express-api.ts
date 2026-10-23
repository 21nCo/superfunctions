/**
 * Express API with cache middleware example
 */

import express from "express";
import { cacheFn, expressMiddleware } from "../src/index.js";

const app = express();
const port = 3000;

// Create cache instance
const cache = cacheFn({
  name: "api-cache",
  storage: "memory",
  maxSize: 1000,
  defaultTTL: 60000,
});

// Simulated database
const db = {
  users: [
    { id: "1", name: "Alice", email: "alice@example.com" },
    { id: "2", name: "Bob", email: "bob@example.com" },
    { id: "3", name: "Charlie", email: "charlie@example.com" },
  ],
  posts: [
    { id: "1", title: "Post 1", authorId: "1" },
    { id: "2", title: "Post 2", authorId: "2" },
    { id: "3", title: "Post 3", authorId: "1" },
  ],
};

// Middleware to log cache stats
app.use(async (req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Get all users (cached for 1 minute)
app.get(
  "/api/users",
  expressMiddleware({
    cache,
    ttl: 60000,
    key: "users:all",
    tags: ["users"],
  }),
  (req, res) => {
    console.log("Fetching users from database...");
    res.json(db.users);
  }
);

// Get user by ID (cached with dynamic key)
app.get(
  "/api/users/:id",
  expressMiddleware({
    cache,
    ttl: 60000,
    key: (req) => `users:${req.params.id}`,
    tags: (req) => ["users", `user:${req.params.id}`],
  }),
  (req, res) => {
    console.log(`Fetching user ${req.params.id} from database...`);
    const user = db.users.find((u) => u.id === req.params.id);
    if (user) {
      res.json(user);
    } else {
      res.status(404).json({ error: "User not found" });
    }
  }
);

// Get posts (cached with pagination)
app.get(
  "/api/posts",
  expressMiddleware({
    cache,
    ttl: 120000,
    key: (req) => `posts:page:${req.query.page || 1}`,
    tags: ["posts"],
  }),
  (req, res) => {
    console.log("Fetching posts from database...");
    res.json(db.posts);
  }
);

// Create user (invalidates cache)
app.post("/api/users", express.json(), async (req, res) => {
  const newUser = {
    id: String(db.users.length + 1),
    ...req.body,
  };
  db.users.push(newUser);

  // Invalidate users cache
  await cache.invalidateByTag("users");

  res.status(201).json(newUser);
});

// Update user (invalidates specific user cache)
app.put("/api/users/:id", express.json(), async (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id);
  if (user) {
    Object.assign(user, req.body);

    // Invalidate specific user cache
    await cache.invalidateByTag(`user:${req.params.id}`);
    await cache.invalidateByTag("users");

    res.json(user);
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// Delete user (invalidates cache)
app.delete("/api/users/:id", async (req, res) => {
  const index = db.users.findIndex((u) => u.id === req.params.id);
  if (index !== -1) {
    db.users.splice(index, 1);

    // Invalidate cache
    await cache.invalidateByTag(`user:${req.params.id}`);
    await cache.invalidateByTag("users");

    res.status(204).send();
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// Get cache stats
app.get("/api/cache/stats", async (req, res) => {
  const stats = await cache.getStats();
  res.json(stats);
});

// Clear cache
app.post("/api/cache/clear", async (req, res) => {
  await cache.clear();
  res.json({ message: "Cache cleared" });
});

// Invalidate by tag
app.post("/api/cache/invalidate/:tag", async (req, res) => {
  await cache.invalidateByTag(req.params.tag);
  res.json({ message: `Invalidated tag: ${req.params.tag}` });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log("Try these endpoints:");
  console.log("  GET  /api/users");
  console.log("  GET  /api/users/:id");
  console.log("  GET  /api/posts");
  console.log("  POST /api/users");
  console.log("  GET  /api/cache/stats");
});
