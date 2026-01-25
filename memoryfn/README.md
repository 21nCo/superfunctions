# MemoryFn

> Self-hostable AI memory system for agents and applications

**Version**: 0.1.0
**Status**: Initial Implementation

## Quick Start

```typescript
import { memoryfn } from "memoryfn";

// Initialize with default settings (or configure storage)
const memory = memoryfn({
  storage: {
    kind: "sqlite", // or 'pg'
    path: "./memories.db"
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

## Features (Planned/In Progress)

- **Durable Memory Storage**: Long-term memory with vector and graph backends
- **Deduplication & Merging**: Intelligent fact extraction and conflict resolution
- **Profile Building**: Static and dynamic user/agent profiles
- **Multi-Modal Support**: Text, PDFs, images, videos
- **Relationship Tracking**: Updates, extends, contradicts, derives

## Documentation

See [.conduct/spec.md](.conduct/spec.md) for the full specification.
