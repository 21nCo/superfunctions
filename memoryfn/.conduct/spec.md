# MemoryFn Specification

> Self-hostable AI memory system for agents and applications

**Version**: 1.0.0  
**Target Release**: Q2 2026  
**Status**: Specification  
**Package Name**: `memoryfn` (TypeScript), `memoryfn` (Python)

---

## Executive Summary

MemoryFn is a self-hostable, provider-agnostic memory service for AI agents and applications. It combines vector search, graph relationships, deduplication/merging, profile building, and high-quality retrieval. Inspired by Supermemory, Mem0, and Letta, MemoryFn simplifies deployment with Postgres/pgvector by default, with optional Qdrant/Neo4j support.

### Key Features

- **Durable Memory Storage**: Long-term memory with vector and graph backends
- **Deduplication & Merging**: Intelligent fact extraction and conflict resolution
- **Profile Building**: Static and dynamic user/agent profiles
- **Multi-Modal Support**: Text, PDFs, images, videos
- **Relationship Tracking**: Updates, extends, contradicts, derives
- **Multi-Tenant**: Container-based scoping (tenant, user, agent, run, project)
- **Self-Hostable**: Run on your infrastructure with Postgres+pgvector
- **MCP Integration**: Expose memory via Model Context Protocol
- **SDK Tools**: Vercel AI SDK, OpenAI middleware, LangFn adapters
- **Observable**: Full WatchFn integration with spans and metrics

---

## Table of Contents

1. [Architecture](#architecture)
2. [Core Concepts](#core-concepts)
3. [Data Model](#data-model)
4. [Storage Backends](#storage-backends)
5. [Pipelines](#pipelines)
6. [APIs](#apis)
7. [SDKs and Tools](#sdks-and-tools)
8. [MCP Integration](#mcp-integration)
9. [Observability](#observability)
10. [Security and Multi-Tenancy](#security-and-multi-tenancy)
11. [Configuration](#configuration)
12. [Deployment](#deployment)
13. [Roadmap](#roadmap)

---

## Architecture

### System Overview

```
┌────────────────────────────────────────────────────┐
│                 Client Applications                 │
│  (Web App, Bot, API, MCP Client, LangFn)          │
└─────────────┬──────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────┐
│              MemoryFn Service Layer                 │
│  ┌──────────────────────────────────────────────┐  │
│  │  HTTP API (Express/Fastify/Hono adapters)   │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  SDK Client (Browser/Node/Python)            │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  MCP Server (SSE/Stdio transports)           │  │
│  └──────────────────────────────────────────────┘  │
└─────────────┬──────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────┐
│              Processing Pipeline                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 1. Extraction → 2. Dedup → 3. Merge          │  │
│  │ 4. Embed → 5. Persist → 6. Graph             │  │
│  └──────────────────────────────────────────────┘  │
└─────────────┬──────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────┐
│                Storage Layer                        │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ PostgreSQL  │  │   Qdrant    │  │   Neo4j    │ │
│  │  +pgvector  │  │  (optional) │  │ (optional) │ │
│  └─────────────┘  └─────────────┘  └────────────┘ │
└────────────────────────────────────────────────────┘
```

### Repository Structure

```
memoryfn/
├── .conduct/
│   └── spec.md                    # This document
├── README.md                      # Overview and quick start
├── typescript/                    # TypeScript implementation
│   ├── package.json               # Package: memoryfn
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts
│   │   ├── client/                # SDK client
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── core/
│   │   │   ├── pipeline.ts        # Main processing pipeline
│   │   │   ├── config.ts          # Configuration types
│   │   │   ├── types.ts           # Core types
│   │   │   ├── errors.ts          # Error classes
│   │   │   └── db-adapter.ts      # @superfunctions/db adapter
│   │   ├── providers/
│   │   │   ├── llm/               # LLM adapters
│   │   │   │   ├── openai.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── google.ts
│   │   │   │   └── ollama.ts
│   │   │   ├── embed/             # Embedding adapters
│   │   │   │   ├── openai.ts
│   │   │   │   ├── fastembed.ts
│   │   │   │   └── hf.ts
│   │   │   └── rerank/            # Reranker adapters
│   │   │       ├── cohere.ts
│   │   │       └── hf.ts
│   │   ├── storage/
│   │   │   ├── pg/                # Postgres+pgvector via @superfunctions/db
│   │   │   │   ├── index.ts
│   │   │   │   ├── schema.ts
│   │   │   │   └── queries.ts
│   │   │   ├── qdrant/            # Optional vector store
│   │   │   │   └── index.ts
│   │   │   ├── sqlite/            # Dev mode via @superfunctions/db
│   │   │   │   └── index.ts
│   │   │   ├── graph/
│   │   │   │   └── neo4j.ts       # Optional graph backend
│   │   │   └── adapter.ts         # Storage adapter interface
│   │   ├── retrieval/
│   │   │   ├── vector.ts          # Vector retrieval
│   │   │   ├── graph.ts           # Graph traversal
│   │   │   ├── hybrid.ts          # Hybrid (vector + keyword + graph)
│   │   │   └── reranker.ts        # Result reranking
│   │   ├── extraction/
│   │   │   ├── facts.ts           # LLM-based fact extraction
│   │   │   ├── relations.ts       # Relationship detection
│   │   │   ├── dedup.ts           # Deduplication logic
│   │   │   └── merge.ts           # Merge/update logic
│   │   ├── mcp/
│   │   │   ├── server.ts          # MCP server implementation
│   │   │   ├── tools.ts           # MCP tool definitions
│   │   │   └── transports.ts      # SSE and stdio
│   │   ├── tools/
│   │   │   ├── ai-sdk.ts          # Vercel AI SDK tools
│   │   │   ├── openai-middleware.ts # OpenAI middleware
│   │   │   └── langfn-adapter.ts  # LangFn retriever adapter
│   │   ├── http/
│   │   │   ├── router.ts          # Generic HTTP routes
│   │   │   ├── handlers.ts        # Request handlers
│   │   │   ├── auth.ts            # Auth integration
│   │   │   └── adapters/          # Framework adapters
│   │   │       ├── express.ts     # Uses @superfunctions/http-express
│   │   │       ├── fastify.ts     # Uses @superfunctions/http-fastify
│   │   │       ├── hono.ts        # Uses @superfunctions/http-hono
│   │   │       ├── next.ts        # Uses @superfunctions/http-next
│   │   │       └── sveltekit.ts   # Uses @superfunctions/http-sveltekit
│   │   ├── observability/
│   │   │   ├── watchfn.ts         # WatchFn integration
│   │   │   ├── metrics.ts         # Metrics tracking
│   │   │   └── otel.ts            # OTLP bridge
│   │   ├── policies/
│   │   │   ├── redaction.ts       # PII redaction (secfn)
│   │   │   └── rls.ts             # Row-level security helpers
│   │   └── utils/
│   │       ├── hashing.ts         # SHA-256/SimHash
│   │       ├── text.ts            # Text processing
│   │       ├── ranking.ts         # Hybrid rank, MMR, RRF
│   │       └── similarity.ts      # Cosine similarity
│   ├── tests/
│   └── examples/
│
├── python/                        # Python SDK (future)
│   ├── pyproject.toml             # Package: memoryfn
│   ├── memoryfn/
│   │   ├── __init__.py
│   │   ├── client.py
│   │   └── types.py
│   └── tests/
│
└── docs/
    ├── getting-started.md
    ├── concepts.md
    ├── api-reference.md
    └── deployment.md
```

---

## Core Concepts

### Memory Containers

**Container Tags** scope memories to specific contexts:

- `tenant:{id}` - Organization/tenant level
- `user:{id}` - User-specific memories
- `agent:{id}` - Agent-specific knowledge
- `run:{id}` - Conversation/session level
- `project:{id}` - Project-specific context

**Example:**
```typescript
await memory.add({
  content: "User prefers dark mode",
  containerTags: ["tenant:acme", "user:alice"],
  type: "profile_static"
});
```

### Memory Types

1. **profile_static**: Stable facts (name, preferences, fixed attributes)
2. **profile_dynamic**: Evolving facts (current job, recent activity)
3. **conversational**: Extracted facts from chat conversations
4. **procedural**: How-to knowledge, SOPs, workflows
5. **document**: Content extracted from files/pages
6. **derived**: AI-inferred facts with provenance

### Relationship Semantics

**Four relationship types track memory evolution:**

#### 1. Updates
New information supersedes old information.

```typescript
// Old memory
{ id: "mem1", content: "Alice works as Engineer at Acme", isLatest: true }

// New information arrives
{ id: "mem2", content: "Alice promoted to Director at Acme", isLatest: true }

// Relationship created
{ fromId: "mem2", toId: "mem1", type: "updates" }
// mem1.isLatest = false
```

#### 2. Extends
New information adds detail without contradiction.

```typescript
// Base memory
{ id: "mem1", content: "Alice is Director at Acme" }

// Additional detail
{ id: "mem2", content: "Alice leads the AI team and reports to CTO" }

// Relationship
{ fromId: "mem2", toId: "mem1", type: "extends" }
// Both remain isLatest = true
```

#### 3. Contradicts
Conflicting information requiring resolution.

```typescript
// Existing memory
{ id: "mem1", content: "Alice prefers Python", confidence: 0.8 }

// Conflicting info
{ id: "mem2", content: "Alice prefers TypeScript", confidence: 0.9 }

// Relationship with reasoning
{ fromId: "mem2", toId: "mem1", type: "contradicts", 
  reasoning: "More recent statement with higher confidence" }
// mem1.isLatest = false (or both kept with metadata)
```

#### 4. Derives
AI-inferred connections between facts.

```typescript
// Source facts
{ id: "mem1", content: "Alice discusses AI frequently" }
{ id: "mem2", content: "Alice leads AI team at Acme" }

// Derived fact
{ id: "mem3", content: "Acme is focused on AI technology", 
  type: "derived", confidence: 0.7 }

// Relationships
{ fromId: "mem3", toId: "mem1", type: "derives" }
{ fromId: "mem3", toId: "mem2", type: "derives" }
```

---

## Data Model

### Memory Record

```typescript
interface Memory {
  id: string;                          // UUID
  tenantId: string;                    // Primary tenant
  containerTags: string[];             // Scoping tags
  type: MemoryType;                    // Memory classification
  content: string;                     // Normalized fact text
  embedding: number[] | null;          // Vector embedding
  metadata: {
    source?: string;                   // URL, file path, "chat"
    sourceType?: "url" | "file" | "chat" | "api";
    actor?: "user" | "assistant";      // Who said it
    confidence?: number;               // 0-1 confidence score
    category?: string;                 // User-defined category
    tags?: string[];                   // User-defined tags
    spans?: Array<{                    // Source text spans
      start: number;
      end: number;
      text: string;
    }>;
    [key: string]: any;                // Extensible
  };
  isLatest: boolean;                   // For update chains
  createdAt: number;                   // Unix timestamp
  updatedAt: number;                   // Unix timestamp
}

type MemoryType = 
  | "profile_static"
  | "profile_dynamic"
  | "conversational"
  | "procedural"
  | "document"
  | "derived";
```

### Relationship Record

```typescript
interface MemoryRelationship {
  id: string;                          // UUID
  fromId: string;                      // Source memory ID
  toId: string;                        // Target memory ID
  type: RelationType;                  // Relationship type
  confidence: number;                  // 0-1 confidence
  reasoning?: string;                  // LLM explanation
  createdAt: number;                   // Unix timestamp
}

type RelationType = "updates" | "extends" | "contradicts" | "derives";
```

### Ingest Event

```typescript
interface IngestEvent {
  id: string;                          // UUID
  tenantId: string;
  source: "chat" | "doc" | "api" | "connector";
  payloadRef?: string;                 // Reference to original payload
  status: IngestStatus;
  error?: string;
  progress?: {
    total: number;
    completed: number;
    currentStep: string;
  };
  result?: {
    memoriesCreated: number;
    memoriesUpdated: number;
    memoriesMerged: number;
    relationshipsCreated: number;
  };
  createdAt: number;
  updatedAt: number;
}

type IngestStatus = 
  | "queued"
  | "extracting"
  | "embedding"
  | "indexing"
  | "graphing"
  | "done"
  | "error";
```

---

## Storage Backends

### Default: Postgres + pgvector

**Why Postgres?**
- Self-hostable with Docker
- Vector search via pgvector extension
- ACID transactions
- JSON support for metadata
- Proven scalability
- Cost-effective

**Integration with @superfunctions/db:**

MemoryFn uses `@superfunctions/db` for database abstraction, supporting multiple ORMs (Drizzle, Prisma, Kysely):

```typescript
import { createDbAdapter } from "@superfunctions/db";

const db = createDbAdapter({
  adapter: "drizzle",  // or "prisma" or "kysely"
  connection: {
    url: process.env.DATABASE_URL
  }
});
```

**Schema:**

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Memories table
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  container_tags TEXT[] NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),              -- OpenAI default dims
  metadata JSONB NOT NULL DEFAULT '{}',
  is_latest BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relationships table
CREATE TABLE memory_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  to_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ingest events table
CREATE TABLE ingest_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_ref TEXT,
  status TEXT NOT NULL,
  error TEXT,
  progress JSONB,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_memories_tenant ON memories(tenant_id);
CREATE INDEX idx_memories_container_tags ON memories USING GIN(container_tags);
CREATE INDEX idx_memories_is_latest ON memories(is_latest);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_relationships_from ON memory_relationships(from_id);
CREATE INDEX idx_relationships_to ON memory_relationships(to_id);
CREATE INDEX idx_relationships_type ON memory_relationships(type);

CREATE INDEX idx_ingest_events_tenant ON ingest_events(tenant_id);
CREATE INDEX idx_ingest_events_status ON ingest_events(status);
```

### Optional: Qdrant (Vector Store)

For high-scale vector workloads:

```typescript
const memory = memoryfn({
  storage: {
    kind: "qdrant",
    url: "http://localhost:6333",
    collectionName: "memories",
    vectorDims: 1536
  }
});
```

### Optional: Neo4j (Graph Store)

For complex relationship traversal:

```typescript
const memory = memoryfn({
  storage: {
    kind: "pg",
    url: process.env.DATABASE_URL,
    dbAdapter: "drizzle"  // Uses @superfunctions/db
  },
  graph: {
    kind: "neo4j",
    url: "bolt://localhost:7687",
    username: "neo4j",
    password: process.env.NEO4J_PASSWORD
  }
});
```

### Dev Mode: SQLite

For local development without external dependencies:

```typescript
const memory = memoryfn({
  storage: {
    kind: "sqlite",
    path: "./memories.db",
    dbAdapter: "drizzle"  // Uses @superfunctions/db
  }
});
```

---

## Pipelines

### Add Pipeline

**Input:** Messages, documents, or raw text  
**Output:** Memory records with relationships

**Steps:**

```
1. Normalize Input
   ├─ Parse messages (if chat)
   ├─ Extract text (if document)
   └─ Segment into candidate facts

2. Fact Extraction (LLM)
   ├─ Atomic fact generation
   ├─ Entity detection
   ├─ Confidence scoring
   └─ Source span tracking

3. Deduplication
   ├─ Hash-based exact match
   ├─ Embedding similarity search
   └─ Filter near-duplicates

4. Conflict Resolution (LLM)
   ├─ Detect contradictions
   ├─ Determine relationship type
   ├─ Update isLatest flags
   └─ Generate reasoning

5. Embedding
   ├─ Batch embedding generation
   ├─ Normalize vectors
   └─ Store embeddings

6. Persistence
   ├─ Write to vector store
   ├─ Update relationships
   └─ Set metadata

7. Graph Building (optional)
   ├─ Entity linking
   ├─ Relationship inference
   └─ Graph persistence

8. Result
   └─ Return memory IDs and summary
```

**Implementation:**

```typescript
async add(input: AddMemoryInput): Promise<AddMemoryResult> {
  const span = watch.startSpan("memoryfn.add");
  
  try {
    // 1. Normalize
    const normalized = await this.normalizeInput(input);
    
    // 2. Extract facts
    const facts = await this.extractFacts(normalized, {
      containerTags: input.containerTags,
      type: input.type
    });
    
    // 3. Deduplicate
    const uniqueFacts = await this.deduplicateFacts(facts, input.containerTags);
    
    // 4. Resolve conflicts
    const resolved = await this.resolveConflicts(uniqueFacts, input.containerTags);
    
    // 5. Embed
    const embeddings = await this.embedder.embedBatch(
      resolved.map(f => f.content)
    );
    
    // 6. Persist
    const memories = await this.storage.insertMemories(
      resolved.map((fact, i) => ({
        ...fact,
        embedding: embeddings[i],
        containerTags: input.containerTags
      }))
    );
    
    // 7. Build relationships
    const relationships = await this.buildRelationships(memories);
    await this.storage.insertRelationships(relationships);
    
    // 8. Optional: Update graph
    if (this.graph) {
      await this.graph.updateGraph(memories, relationships);
    }
    
    span.end({ memoriesCreated: memories.length });
    
    return {
      memories,
      relationships,
      summary: {
        created: memories.filter(m => m.isNew).length,
        updated: memories.filter(m => m.isUpdate).length,
        deduplicated: facts.length - uniqueFacts.length
      }
    };
  } catch (error) {
    span.recordException(error);
    throw error;
  }
}
```

### Search Pipeline

**Input:** Query string, filters, options  
**Output:** Ranked memory results

**Steps:**

```
1. Query Processing
   ├─ Embed query
   ├─ Optional query rewriting
   └─ Extract filters

2. Vector Search
   ├─ KNN search with filters
   ├─ Similarity threshold
   └─ Top-K results

3. Hybrid Ranking (optional)
   ├─ BM25 keyword scoring
   ├─ Combine with vector scores
   └─ Reciprocal rank fusion

4. Reranking (optional)
   ├─ Cross-encoder reranking
   ├─ Query-result relevance
   └─ Reorder by new scores

5. Relationship Traversal (optional)
   ├─ Follow "extends" links
   ├─ Include related memories
   └─ Merge context

6. Filter by isLatest (optional)
   └─ Remove superseded memories

7. Context Packing
   ├─ Budget token allocation
   ├─ Prioritize by score
   └─ Format for injection

8. Result
   └─ Return ranked memories with metadata
```

**Implementation:**

```typescript
async search(input: SearchMemoryInput): Promise<SearchMemoryResult> {
  const span = watch.startSpan("memoryfn.search");
  
  try {
    // 1. Process query
    const queryEmbedding = await this.embedder.embed(input.q);
    
    // 2. Vector search
    const vectorResults = await this.storage.searchVectors({
      embedding: queryEmbedding,
      containerTags: input.containerTags,
      filters: input.filters,
      topK: input.limit || 10,
      threshold: input.threshold
    });
    
    // 3. Hybrid ranking (if enabled)
    let results = vectorResults;
    if (input.hybridRank) {
      const bm25Scores = await this.computeBM25(input.q, vectorResults);
      results = this.mergeScores(vectorResults, bm25Scores);
    }
    
    // 4. Rerank (if enabled)
    if (input.rerank && this.reranker) {
      results = await this.reranker.rerank(input.q, results, input.limit);
    }
    
    // 5. Traverse relationships (if enabled)
    if (input.traverseRelationships) {
      results = await this.expandWithRelationships(results, ["extends"]);
    }
    
    // 6. Filter latest (if enabled)
    if (input.onlyLatest) {
      results = results.filter(r => r.isLatest);
    }
    
    // 7. Pack context
    const packed = this.packContext(results, input.maxTokens || 4000);
    
    span.end({ resultsReturned: packed.length });
    
    return {
      results: packed,
      metadata: {
        totalFound: vectorResults.length,
        afterRerank: results.length,
        returned: packed.length
      }
    };
  } catch (error) {
    span.recordException(error);
    throw error;
  }
}
```

---

## APIs

### HTTP REST API

**Framework Integration via @superfunctions/http-* adapters:**

```typescript
import { memoryfn } from "memoryfn";
import { createMemoryRouter } from "memoryfn/http";
import express from "express";

const memory = memoryfn({...});

// Express adapter
import { createExpressAdapter } from "@superfunctions/http-express";
const app = express();
app.use("/memory", createMemoryRouter(memory, {
  adapter: createExpressAdapter()
}));

// Or Fastify
import { createFastifyAdapter } from "@superfunctions/http-fastify";
import Fastify from "fastify";
const fastify = Fastify();
fastify.register(createMemoryRouter(memory, {
  adapter: createFastifyAdapter()
}), { prefix: "/memory" });

// Or Hono
import { createHonoAdapter } from "@superfunctions/http-hono";
import { Hono } from "hono";
const app = new Hono();
app.route("/memory", createMemoryRouter(memory, {
  adapter: createHonoAdapter()
}));
```

**API Endpoints:**

```typescript
// Add memory
POST /v1/memories
Body: {
  content?: string,
  messages?: Array<{ role: string; content: string }>,
  documentRef?: string,
  containerTags: string[],
  type?: MemoryType,
  metadata?: Record<string, any>
}
Response: {
  memories: Memory[],
  relationships: MemoryRelationship[],
  summary: { created: number; updated: number; deduplicated: number }
}

// Search memories
POST /v1/memories/search
Body: {
  q: string,
  containerTags: string[],
  filters?: Record<string, any>,
  topK?: number,
  rerank?: boolean,
  traverseRelationships?: boolean,
  onlyLatest?: boolean,
  maxTokens?: number
}
Response: {
  results: Memory[],
  metadata: { totalFound: number; returned: number }
}

// Get user profile
POST /v1/profile
Body: {
  containerTag: string,
  includeStatic?: boolean,
  includeDynamic?: boolean,
  searchQuery?: string
}
Response: {
  profile: {
    static: Memory[],
    dynamic: Memory[]
  },
  searchResults?: Memory[]
}

// Update memory
PATCH /v1/memories/:id
Body: {
  content?: string,
  metadata?: Record<string, any>,
  isLatest?: boolean
}

// Delete memory
DELETE /v1/memories/:id

// Bulk operations
POST /v1/memories/bulk
Body: {
  operations: Array<{
    type: "add" | "update" | "delete",
    data: any
  }>
}

// List memories
GET /v1/memories
Query: containerTags, type, limit, offset

// Get relationships
GET /v1/memories/:id/relationships
Query: type (updates|extends|contradicts|derives)

// Ingest events
GET /v1/ingest/events
GET /v1/ingest/events/:id
```

### SDK Client API

```typescript
import { memoryfn } from "memoryfn";

const memory = memoryfn({
  apiKey: process.env.MEMORYFN_API_KEY,
  baseUrl: "https://memory.example.com"
});

// Add memory
const result = await memory.add({
  content: "User prefers dark mode",
  containerTags: ["user:alice"],
  type: "profile_static"
});

// Search
const results = await memory.search({
  q: "user preferences",
  containerTags: ["user:alice"],
  topK: 10,
  rerank: true
});

// Get profile
const profile = await memory.getProfile({
  containerTag: "user:alice",
  includeStatic: true,
  includeDynamic: true
});

// Update
await memory.update("mem_123", {
  content: "Updated content",
  metadata: { verified: true }
});

// Delete
await memory.delete("mem_123");

// Bulk add
await memory.bulkAdd([
  { content: "Fact 1", containerTags: ["user:alice"] },
  { content: "Fact 2", containerTags: ["user:alice"] }
]);
```

---

## SDKs and Tools

### Vercel AI SDK Tools

```typescript
import { generateText } from "ai";
import { createMemoryTools } from "memoryfn/tools/ai-sdk";
import { openai } from "@ai-sdk/openai";

const memoryTools = createMemoryTools({
  apiKey: process.env.MEMORYFN_API_KEY,
  containerTag: "user:alice"
});

const result = await generateText({
  model: openai("gpt-4"),
  messages: [{ role: "user", content: "What are my preferences?" }],
  tools: {
    ...memoryTools,
    // Other tools...
  }
});

// Tools provided:
// - searchMemories: Search user's memories
// - addMemory: Store new memory
// - getProfile: Get user profile
```

### OpenAI Middleware

```typescript
import OpenAI from "openai";
import { createMemoryMiddleware } from "memoryfn/tools/openai-middleware";

const openai = new OpenAI();

const openaiWithMemory = createMemoryMiddleware(openai, {
  apiKey: process.env.MEMORYFN_API_KEY,
  containerTag: "user:alice",
  mode: "full",                    // "profile" | "query" | "full"
  addMemory: "always",             // "always" | "on_success" | "never"
  conversationId: "chat_123"
});

// Automatic memory injection and storage
const response = await openaiWithMemory.chat.completions.create({
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello!" }]
});
```

**Middleware Modes:**
- `profile`: Inject user profile only
- `query`: Search memories based on current query
- `full`: Profile + query search

### LangFn Retriever Adapter

```typescript
import { langfn } from "langfn";
import { createMemoryRetriever } from "memoryfn/tools/langfn-adapter";

const memory = memoryfn({...});
const lang = langfn({...});

// Use memoryfn as retriever
const ragChain = lang.createRAGChain({
  retriever: createMemoryRetriever(memory, {
    containerTag: "user:alice",
    topK: 5
  }),
  prompt: myPromptTemplate
});

const result = await ragChain.run({ question: "Tell me about X" });
```

---

## MCP Integration

### MCP Server

```typescript
import { createMCPServer } from "memoryfn/mcp";

const mcpServer = createMCPServer({
  memory: memoryfn({...}),
  transport: "sse",              // or "stdio"
  port: 3000,
  auth: {
    type: "api-key",
    validateKey: async (key) => {
      // Validate API key and return container tags
      return { containerTag: "user:alice" };
    }
  }
});

await mcpServer.start();
```

### MCP Tools Exposed

```json
{
  "tools": [
    {
      "name": "searchMemories",
      "description": "Search user's memories for relevant information",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "limit": { "type": "number" },
          "onlyLatest": { "type": "boolean" }
        }
      }
    },
    {
      "name": "addMemory",
      "description": "Store new information in user's memory",
      "inputSchema": {
        "type": "object",
        "properties": {
          "content": { "type": "string" },
          "type": { "type": "string" },
          "metadata": { "type": "object" }
        }
      }
    },
    {
      "name": "getProfile",
      "description": "Get user's profile (static and dynamic facts)",
      "inputSchema": {
        "type": "object",
        "properties": {
          "includeStatic": { "type": "boolean" },
          "includeDynamic": { "type": "boolean" }
        }
      }
    }
  ]
}
```

### MCP Client Usage

```bash
# Install MCP server
npx install-mcp https://memory.example.com/mcp --client claude

# Or use with stdio transport
node memoryfn-mcp-server.js
```

---

## Observability

### WatchFn Integration

**Span Taxonomy:**

```typescript
const SPAN_TYPES = {
  // Pipeline stages
  ADD: "memoryfn.add",
  SEARCH: "memoryfn.search",
  UPDATE: "memoryfn.update",
  DELETE: "memoryfn.delete",
  
  // Extraction
  EXTRACT_FACTS: "memoryfn.extract.facts",
  EXTRACT_RELATIONS: "memoryfn.extract.relations",
  DEDUP: "memoryfn.dedup",
  MERGE: "memoryfn.merge",
  
  // Storage operations
  STORAGE_INSERT: "memoryfn.storage.insert",
  STORAGE_SEARCH: "memoryfn.storage.search",
  STORAGE_UPDATE: "memoryfn.storage.update",
  
  // AI operations
  LLM_CALL: "memoryfn.llm.call",
  EMBED: "memoryfn.embed",
  RERANK: "memoryfn.rerank",
  
  // Graph operations
  GRAPH_UPDATE: "memoryfn.graph.update",
  GRAPH_TRAVERSE: "memoryfn.graph.traverse"
};
```

**Automatic Instrumentation:**

```typescript
const memory = memoryfn({
  storage: { kind: "pg", url: process.env.DATABASE_URL },
  observability: {
    watchfn: watch,
    traceAll: true,
    logPrompts: false,           // Don't log prompts (privacy)
    logResults: true,            // Log result counts
    metrics: {
      enabled: true,
      trackCosts: true,
      trackLatency: true
    }
  }
});
```

**Custom Metrics:**

```typescript
// Latency histogram
watch.recordHistogram("memoryfn.search.latency_ms", duration);

// Token usage counter
watch.recordCounter("memoryfn.embed.tokens", tokenCount);

// Memory operation counter
watch.recordCounter("memoryfn.memories.created", 1);

// Relationship types
watch.recordCounter(`memoryfn.relationships.${type}`, 1);
```

### Cost Tracking

```typescript
const memory = memoryfn({
  observability: {
    costTracking: {
      llm: {
        "gpt-4o-mini": { input: 0.00015, output: 0.0006 }
      },
      embeddings: {
        "text-embedding-3-small": 0.00002
      }
    }
  }
});

// Per-operation costs tracked automatically
const result = await memory.add({...});
console.log(result.cost); // { llm: 0.003, embeddings: 0.0001, total: 0.0031 }
```

---

## Security and Multi-Tenancy

### Authentication

**API Key Authentication:**

```typescript
// In HTTP requests
Authorization: Bearer mem_sk_abc123...

// In SDK
const memory = memoryfn({
  apiKey: "mem_sk_abc123..."
});
```

**Integration with @superfunctions/auth:**

```typescript
import { createAuthMiddleware } from "@superfunctions/auth";
import { createMemoryRouter } from "memoryfn/http";

const router = createMemoryRouter(memory, {
  auth: createAuthMiddleware({
    provider: "jwt",
    secret: process.env.JWT_SECRET,
    validateClaims: (claims) => {
      // Map JWT claims to container tags
      return {
        tenantId: claims.tenant_id,
        containerTags: [
          `tenant:${claims.tenant_id}`,
          `user:${claims.user_id}`
        ]
      };
    }
  })
});
```

### Row-Level Security

**Automatic Scoping:**

```typescript
// All queries automatically scoped by container tags
const results = await memory.search({
  q: "preferences",
  containerTags: ["tenant:acme", "user:alice"]
  // Can only access memories with matching container tags
});
```

**Postgres RLS (optional):**

```sql
-- Enable RLS
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their tenant's memories
CREATE POLICY tenant_isolation ON memories
  USING (tenant_id = current_setting('app.tenant_id')::text);

-- Set tenant_id in session
SET app.tenant_id = 'acme';
```

### Redaction

**PII Protection:**

```typescript
import { createRedactor } from "secfn";

const memory = memoryfn({
  policies: {
    redaction: createRedactor({
      patterns: ["email", "phone", "ssn", "credit_card"],
      mode: "hash",                    // "hash" | "mask" | "drop"
      applyTo: ["content", "traces"]   // What to redact
    })
  }
});

// Content automatically redacted before storage and logging
await memory.add({
  content: "My email is alice@example.com"
  // Stored as: "My email is <REDACTED:EMAIL:abc123>"
});
```

---

## Configuration

### Minimal Configuration

```typescript
import { memoryfn } from "memoryfn";
import { createDbAdapter } from "@superfunctions/db";

const memory = memoryfn({
  storage: {
    kind: "pg",
    url: process.env.DATABASE_URL,
    dbAdapter: "drizzle"  // Uses @superfunctions/db
  }
});
```

### Production Configuration

```typescript
import { memoryfn } from "memoryfn";
import { watchFn } from "watchfn";
import { getSecret } from "secfn";
import { createDbAdapter } from "@superfunctions/db";

const memory = memoryfn({
  // Storage (using @superfunctions/db)
  storage: {
    kind: "pg",
    url: await getSecret("DATABASE_URL"),
    dbAdapter: "drizzle",  // or "prisma" or "kysely"
    pool: {
      min: 2,
      max: 20,
      idleTimeoutMillis: 30000
    }
  },
  
  // Optional graph backend
  graph: {
    kind: "neo4j",
    url: "bolt://neo4j:7687",
    username: "neo4j",
    password: await getSecret("NEO4J_PASSWORD")
  },
  
  // LLM for extraction
  llm: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: await getSecret("OPENAI_API_KEY"),
    temperature: 0,
    maxTokens: 2000
  },
  
  // Embeddings
  embedder: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: await getSecret("OPENAI_API_KEY"),
    dims: 1536,
    batchSize: 32
  },
  
  // Reranking (optional)
  reranker: {
    provider: "cohere",
    model: "rerank-english-v3.0",
    apiKey: await getSecret("COHERE_API_KEY")
  },
  
  // Observability
  observability: {
    watchfn: watchFn({ name: "memoryfn" }),
    traceAll: true,
    logResults: true,
    metrics: {
      enabled: true,
      trackCosts: true,
      trackLatency: true
    }
  },
  
  // Security
  policies: {
    redaction: {
      patterns: ["email", "phone", "ssn"],
      mode: "hash"
    },
    maxMemoriesPerContainer: 100000,
    maxMemorySizeBytes: 50000
  },
  
  // Performance
  cache: {
    enabled: true,
    ttl: 3600,
    maxSize: 1000
  },
  
  retry: {
    maxRetries: 3,
    backoff: "exponential"
  }
});
```

---

## Deployment

### Docker Compose

```yaml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: memoryfn
      POSTGRES_USER: memoryfn
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  memoryfn:
    image: memoryfn:latest
    environment:
      DATABASE_URL: postgres://memoryfn:${POSTGRES_PASSWORD}@postgres:5432/memoryfn
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      - postgres

  neo4j:
    image: neo4j:5
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
    volumes:
      - neo4j_data:/data
    ports:
      - "7474:7474"
      - "7687:7687"

  watchfn:
    image: watchfn:latest
    ports:
      - "4000:4000"

volumes:
  postgres_data:
  neo4j_data:
```

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost:5432/memoryfn
OPENAI_API_KEY=sk-...

# Optional
NEO4J_URL=bolt://localhost:7687
NEO4J_PASSWORD=...
COHERE_API_KEY=...
MEMORYFN_API_KEY=mem_sk_...
WATCHFN_URL=http://localhost:4000
PORT=3000
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memoryfn
spec:
  replicas: 3
  selector:
    matchLabels:
      app: memoryfn
  template:
    metadata:
      labels:
        app: memoryfn
    spec:
      containers:
      - name: memoryfn
        image: memoryfn:latest
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: memoryfn-secrets
              key: database-url
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: memoryfn-secrets
              key: openai-api-key
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
```

---

## Roadmap

### v0.1 (Q2 2026)
- ✅ Postgres+pgvector backend
- ✅ TypeScript SDK and service
- ✅ Basic add/search operations
- ✅ Vercel AI SDK tools
- ✅ OpenAI middleware (profile/query/full modes)
- ✅ WatchFn integration
- ✅ HTTP API with Express/Fastify/Hono adapters

### v0.2 (Q2 2026)
- ✅ Relationship builder (updates/extends/contradicts/derives)
- ✅ onlyLatest and traverseRelationships flags
- ✅ Reranker support (Cohere, HuggingFace)
- ✅ Hybrid search (vector + BM25)
- ✅ Deduplication and merge logic

### v0.3 (Q3 2026)
- ✅ MCP server (SSE and stdio transports)
- ✅ LangFn retriever adapter
- ✅ Profile API (static/dynamic)
- ✅ Batch operations
- ✅ Python SDK

### v1.0 (Q4 2026)
- ✅ Multi-tenant RBAC
- ✅ Neo4j graph backend
- ✅ Evaluation harness (testfn integration)
- ✅ Database migrations (Alembic/Prisma)
- ✅ Production docs and examples
- ✅ Performance tuning and benchmarks
- ✅ Connectors framework (Google Drive, Notion, etc.)

---

## Integration Examples

### Example 1: Chat with Memory

```typescript
import { memoryfn } from "memoryfn";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const memory = memoryfn({...});

async function chatWithMemory(userMessage: string, userId: string) {
  // Search relevant memories
  const memories = await memory.search({
    q: userMessage,
    containerTags: [`user:${userId}`],
    topK: 5,
    rerank: true
  });
  
  // Build context
  const context = memories.results
    .map(m => m.content)
    .join("\n");
  
  // Generate response
  const response = await generateText({
    model: openai("gpt-4"),
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant. Use this context about the user:\n\n${context}`
      },
      { role: "user", content: userMessage }
    ]
  });
  
  // Store conversation
  await memory.add({
    messages: [
      { role: "user", content: userMessage },
      { role: "assistant", content: response.text }
    ],
    containerTags: [`user:${userId}`],
    type: "conversational"
  });
  
  return response.text;
}
```

### Example 2: OpenAI with Infinite Context

```typescript
import OpenAI from "openai";
import { createMemoryMiddleware } from "memoryfn/tools/openai-middleware";
import { memoryfn } from "memoryfn";

const memory = memoryfn({...});
const openai = new OpenAI();

const openaiWithMemory = createMemoryMiddleware(openai, {
  memory,
  containerTag: "user:alice",
  mode: "full",
  addMemory: "always",
  conversationId: "chat_123"
});

// All context automatically injected and stored
const response = await openaiWithMemory.chat.completions.create({
  model: "gpt-4",
  messages: [
    { role: "user", content: "What did we discuss last week?" }
  ]
});
```

### Example 3: RAG with LangFn

```typescript
import { langfn } from "langfn";
import { memoryfn } from "memoryfn";
import { createMemoryRetriever } from "memoryfn/tools/langfn-adapter";

const memory = memoryfn({...});
const lang = langfn({...});

const ragChain = lang.createRAGChain({
  retriever: createMemoryRetriever(memory, {
    containerTag: "project:docs",
    topK: 5,
    rerank: true
  }),
  prompt: lang.prompts.create({
    template: `Answer based on the context:\n\n{context}\n\nQuestion: {question}`
  })
});

const answer = await ragChain.run({
  question: "How do I deploy the application?"
});
```

---

## Comparison with Alternatives

### vs. Mem0

**Similarities:**
- Fact extraction and deduplication
- Multiple storage backends
- Relationship tracking

**Differences:**
- MemoryFn: Self-hostable by default (Postgres)
- Mem0: Defaults to Qdrant cloud
- MemoryFn: Integrated with superfunctions ecosystem
- MemoryFn: First-class MCP support

### vs. Letta

**Similarities:**
- Durable memory for agents
- Multi-level memory scoping

**Differences:**
- Letta: Full agent framework
- MemoryFn: Memory-only service
- MemoryFn: Simpler deployment (just Postgres)
- MemoryFn: Works with any LLM framework

### vs. Supermemory

**Similarities:**
- Knowledge graph approach
- Profile building (static/dynamic)
- MCP integration

**Differences:**
- Supermemory: Cloudflare Workers focused
- MemoryFn: Provider-agnostic, self-hostable
- MemoryFn: More relationship types
- MemoryFn: TypeScript + Python SDKs

---

## Technology Stack

### Core Dependencies

**TypeScript (`typescript/package.json`):**

```json
{
  "name": "memoryfn",
  "dependencies": {
    "@superfunctions/db": "workspace:*",
    "@superfunctions/http": "workspace:*",
    "zod": "^3.x",
    "zod-to-json-schema": "^3.x"
  },
  "peerDependencies": {
    "@superfunctions/http-express": "workspace:*",
    "@superfunctions/http-fastify": "workspace:*",
    "@superfunctions/http-hono": "workspace:*",
    "@superfunctions/http-next": "workspace:*",
    "@superfunctions/http-sveltekit": "workspace:*",
    "@superfunctions/auth": "workspace:*",
    "watchfn": "workspace:*",
    "secfn": "workspace:*"
  },
  "optionalDependencies": {
    "qdrant-client": "^1.x",
    "neo4j-driver": "^5.x",
    "cohere-ai": "^7.x"
  }
}
```

**Python (`python/pyproject.toml`):**

```toml
[project]
name = "memoryfn"
dependencies = [
  "superfunctions>=0.1.0",
  "pydantic>=2.6",
  "httpx>=0.27",
  "tiktoken>=0.7",
  "pgvector>=0.2.0",
  "psycopg[binary]>=3.1"
]

[project.optional-dependencies]
fastapi = ["superfunctions-fastapi>=0.1.0"]
flask = ["superfunctions-flask>=0.1.0"]
qdrant = ["qdrant-client>=1.7"]
neo4j = ["neo4j>=5.16"]
cohere = ["cohere>=5.0"]
```

---

## Related Documents

- `langfn/.conduct/improvements.spec.md` - LangFn improvements
- `langfn/SPEC.md` - LangFn specification
- `/AGENTS.md` - Repository conventions
- `memoryfn/.conduct/implementation.md` - Implementation plan (TBD)

---

**Last Updated**: 2026-01-13  
**Authors**: AI Agent  
**Status**: Specification for Review  
**License**: MIT
