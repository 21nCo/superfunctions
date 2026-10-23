# MemoryFn

> Self-hostable AI memory system for agents and applications

**Version**: 0.1.0
**Status**: Initial Implementation

## Quick Start

```typescript
import { memoryfn } from "@memoryfn/core";

// Initialize with default settings (or configure storage)
const memory = memoryfn({
  storage: {
    // Process-local persistence. Use `pg` for restart-durable storage.
    kind: "sqlite"
  }
});

// Add a memory
await memory.add({
  content: "User prefers dark mode",
  containerTags: ["user:alice"],
  type: "profile_static"
});

// Search memories
const results = await memory.search({
  q: "preferences",
  containerTags: ["user:alice"]
});

console.log(results.results);
```

The function-owned `@memoryfn/admin` package exposes only the operations backed
by this public runtime today: environment-scoped `memories.search` and
`memories.ingest`. The binding derives tenant and container scope from the
authenticated Super Console context; callers cannot select another tenant.

## Features (Planned/In Progress)

- **Durable Memory Storage**: Long-term memory with vector and graph backends
- **Deduplication & Merging**: Intelligent fact extraction and conflict resolution
- **Profile Building**: Static and dynamic user/agent profiles
- **Multi-Modal Support**: Text, PDFs, images, videos
- **Relationship Tracking**: Updates, extends, contradicts, derives

## Documentation

See [.conduct/spec.md](.conduct/spec.md) for the full specification.
