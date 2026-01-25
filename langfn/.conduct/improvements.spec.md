# LangFn Improvements & Refinements Specification

> Recommended improvements, scope refinements, and alignment with superfunctions patterns

**Version**: 1.1.0  
**Date**: 2026-01-13  
**Status**: Proposal  
**Related**: langfn/SPEC.md, memoryfn/.conduct/spec.md

---

## Executive Summary

This document proposes refinements to langfn to better align with superfunctions patterns, improve developer experience, and clarify boundaries with the new memoryfn package. Key recommendations include narrowing scope to orchestration/observability, adding MCP as first-class integration, and moving durable memory features to memoryfn.

---

## 1. Scope Refinement

### Current State
LangFn currently includes both orchestration (chains, graphs, tools) and memory management (vector stores, conversation history, entity memory).

### Proposed Scope

**Keep in LangFn:**
- LLM provider abstraction and model management
- Orchestration primitives (chains, graphs, routers, parallel execution)
- Tool system and function calling
- Prompts and templates
- Streaming and real-time responses
- Observability and tracing integration
- HTTP adapters and API endpoints
- Evaluation framework
- Ephemeral, per-request memory utilities (buffer, rolling summary)

**Move to MemoryFn:**
- Vector store integrations and long-term memory
- Entity and graph memory
- Conversation persistence across sessions
- Profile building (static/dynamic user facts)
- Memory deduplication and merging
- Long-horizon summarization
- RAG with durable storage

**Rationale:**
- Follows superfunctions pattern: one function, one capability
- Reduces cognitive load and package size
- Enables independent versioning and optimization
- LangFn stays focused on orchestration; MemoryFn handles persistence

---

## 2. Architecture Improvements

### 2.1 Model Context Protocol (MCP) Integration

**Add First-Class MCP Support:**

```typescript
// Location: langfn/typescript/src/mcp/
import { MCPClient, MCPServer } from "langfn/mcp";

// Client for external MCP servers
const mcpClient = new MCPClient({
  transport: "sse", // or "stdio"
  url: "https://mcp-server.example.com",
  auth: {
    type: "oauth",
    credentials: mcpOAuthCredentials
  }
});

// Discover and use MCP tools
const tools = await mcpClient.listTools();
const result = await mcpClient.executeTool("search_web", { query: "AI news" });

// MCP server for exposing langfn capabilities
const mcpServer = new MCPServer({
  tools: [customTool1, customTool2],
  transport: "sse",
  port: 3000
});
```

**Features:**
- SSE and stdio transports
- OAuth session management
- Tool discovery and schema validation
- Health monitoring
- Per-agent MCP tool associations

**Files to Add:**
- `src/mcp/client.ts` - MCP client implementation
- `src/mcp/server.ts` - MCP server implementation
- `src/mcp/transports.ts` - SSE, stdio, HTTP streaming
- `src/mcp/oauth.ts` - OAuth flow handling
- `src/mcp/tools.ts` - MCP tool adapters

### 2.2 Structured Outputs Layer

**Provider-Agnostic Structured Outputs:**

```typescript
import { z } from "zod";
import { StructuredOutput } from "langfn/structured";

const schema = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number().min(0).max(1),
  topics: z.array(z.string())
});

// Works across all providers
const result = await lang.complete("Analyze this text", {
  structuredOutput: {
    schema,
    mode: "json" // or "function_call" or "reasoning_trace"
  }
});

// Typed result
const parsed: z.infer<typeof schema> = result.parsed;
```

**Features:**
- Zod schemas in TypeScript, Pydantic in Python
- Zero-copy mapping to provider formats
- Reasoning trace support for o1/o3 models
- Validation and error recovery
- Streaming structured outputs

**Files to Add:**
- `src/structured/index.ts` - Main interface
- `src/structured/adapters.ts` - Provider-specific mappings
- `src/structured/validation.ts` - Runtime validation
- `src/structured/streaming.ts` - Streaming support

### 2.3 Unified Streaming Shape

**Standardized Stream Events:**

```typescript
type StreamEvent = 
  | { type: "content"; content: string; delta: string }
  | { type: "tool_call"; toolName: string; args: any; id: string }
  | { type: "tool_result"; toolCallId: string; result: any }
  | { type: "token_usage"; promptTokens: number; completionTokens: number }
  | { type: "trace_event"; span: string; metadata: any }
  | { type: "reasoning"; step: string; thinking: string }
  | { type: "end"; finishReason: string };

// Consistent across SSE, WebSocket, async iterator
for await (const event of lang.stream(prompt)) {
  switch (event.type) {
    case "content":
      process.stdout.write(event.delta);
      break;
    case "tool_call":
      console.log(`Calling ${event.toolName}`);
      break;
  }
}
```

**Benefits:**
- Single API surface for all streaming modes
- Easy to add new event types
- Type-safe event handling
- Clear separation of concerns

### 2.4 Cancellation and Abort Control

**AbortSignal Support:**

```typescript
const controller = new AbortController();

// Pass signal to any async operation
const promise = lang.complete("Long query", {
  signal: controller.signal
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  const result = await promise;
} catch (err) {
  if (err.name === "AbortError") {
    console.log("Request cancelled");
  }
}
```

**Features:**
- AbortController in TypeScript
- asyncio cancellation in Python
- Propagates through tool calls
- Clean resource cleanup
- Idempotency guarantees

### 2.5 Cost and Usage Accounting

**Built-in Cost Tracking:**

```typescript
import { CostMeter } from "langfn/observability";

const costMeter = new CostMeter({
  providers: {
    openai: {
      "gpt-4": { input: 0.03, output: 0.06 }, // per 1K tokens
      "gpt-3.5-turbo": { input: 0.001, output: 0.002 }
    },
    anthropic: {
      "claude-3-opus": { input: 0.015, output: 0.075 }
    }
  }
});

const lang = langfn({
  model: { provider: "openai", model: "gpt-4" },
  observability: {
    costMeter,
    budgets: {
      perRequest: 0.50,
      perUser: 100.00
    }
  }
});

// Automatic cost tracking
const result = await lang.complete("Hello");
console.log(result.cost); // { input: 0.003, output: 0.006, total: 0.009 }

// Aggregate costs
const summary = await costMeter.getSummary({
  timeRange: "last-24h",
  groupBy: ["model", "user"]
});
```

**Files to Add:**
- `src/observability/cost-meter.ts`
- `src/observability/budgets.ts`

### 2.6 Enhanced Error Model

**Normalized Error Classes:**

```typescript
// Base error hierarchy
class LangFnError extends Error {
  constructor(
    message: string,
    public code: string,
    public provider?: string,
    public metadata?: Record<string, any>
  ) {}
}

class RateLimitError extends LangFnError {
  constructor(public retryAfter?: number, metadata?: any) {
    super("Rate limit exceeded", "RATE_LIMIT", undefined, metadata);
  }
}

class ProviderAuthError extends LangFnError {}
class ToolExecutionError extends LangFnError {}
class SchemaValidationError extends LangFnError {}
class TimeoutError extends LangFnError {}
class ContextLengthError extends LangFnError {}

// Usage with retry logic
try {
  const result = await lang.complete(prompt);
} catch (err) {
  if (err instanceof RateLimitError) {
    await sleep(err.retryAfter || 1000);
    // retry...
  } else if (err instanceof ContextLengthError) {
    // summarize and retry...
  }
}
```

**Files to Modify:**
- `src/core/errors.ts` - Add error classes
- All providers - Throw normalized errors

### 2.7 Batch Processing

**Concurrent and Provider-Native Batching:**

```typescript
// Concurrent processing with rate limiting
const results = await lang.completeBatch([
  { prompt: "Q1", metadata: { id: "1" } },
  { prompt: "Q2", metadata: { id: "2" } },
  { prompt: "Q3", metadata: { id: "3" } }
], {
  concurrency: 5,
  retryFailed: true,
  partialResults: true // Return successes even if some fail
});

// Provider-native batching (where supported)
const batchJob = await lang.createBatch({
  requests: [...],
  provider: "openai" // Uses OpenAI Batch API
});

// Poll for completion
const status = await batchJob.getStatus();
const results = await batchJob.getResults();
```

**Files to Add:**
- `src/orchestration/batch.ts`
- `src/models/batch-providers.ts`

---

## 3. Observability Enhancements

### 3.1 WatchFn Span Taxonomy

**Standardized Span Names:**

```typescript
const SPAN_TYPES = {
  // Prompt construction
  PROMPT_BUILD: "langfn.prompt.build",
  PROMPT_TEMPLATE: "langfn.prompt.template",
  
  // Model calls
  PROVIDER_CALL: "langfn.provider.call",
  PROVIDER_STREAM: "langfn.provider.stream",
  
  // Tool execution
  TOOL_EXECUTE: "langfn.tool.execute",
  TOOL_VALIDATE: "langfn.tool.validate",
  
  // Orchestration
  CHAIN_EXECUTE: "langfn.chain.execute",
  GRAPH_EXECUTE: "langfn.graph.execute",
  
  // Memory (ephemeral only)
  MEMORY_RETRIEVE: "langfn.memory.retrieve",
  MEMORY_SUMMARIZE: "langfn.memory.summarize",
  
  // Evaluation
  EVAL_RUN: "langfn.eval.run",
  EVAL_METRIC: "langfn.eval.metric"
};
```

**Automatic Tracing:**

```typescript
const lang = langfn({
  observability: {
    watchfn: watch,
    traceAll: true, // All operations auto-traced
    logPrompts: true,
    logResponses: true,
    redaction: ["apiKey", "password"] // Fields to redact
  }
});
```

### 3.2 OpenTelemetry Bridge

**Optional OTLP Export:**

```typescript
import { OTelExporter } from "langfn/observability/otel";

const lang = langfn({
  observability: {
    watchfn: watch, // Primary
    otelExporter: new OTelExporter({
      endpoint: "http://otel-collector:4318",
      serviceName: "my-ai-app"
    })
  }
});

// Spans mirrored to both WatchFn and OTLP
```

**Files to Add:**
- `src/observability/otel-exporter.ts`

### 3.3 Redaction Middleware

**PII and Sensitive Data Redaction:**

```typescript
import { createRedactor } from "secfn";

const lang = langfn({
  observability: {
    redactor: createRedactor({
      patterns: ["email", "phone", "ssn", "credit_card"],
      mode: "hash" // or "mask" or "drop"
    })
  }
});

// Prompts and responses automatically redacted in traces
```

**Integration:**
- Uses secfn for detection and redaction
- Applied before WatchFn/OTLP recording
- Configurable per-field or pattern-based

---

## 4. HTTP API Hardening

### 4.1 Authentication and Authorization

**Integration with @superfunctions/auth:**

```typescript
import { createLangFnRouter } from "langfn/http";
import { createExpressAdapter } from "@superfunctions/http-express";
import { createAuthMiddleware } from "@superfunctions/auth";

const router = createLangFnRouter(lang, {
  adapter: createExpressAdapter(),
  auth: createAuthMiddleware({
    provider: "jwt",
    secret: process.env.JWT_SECRET
  }),
  rateLimiting: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000
  }
});

app.use("/ai", router);
```

### 4.2 Multi-Tenant Headers

**Standard Headers for Scoping:**

```
x-tenant-id: tenant_123
x-user-id: user_456
x-agent-id: agent_789
x-run-id: run_abc
x-conversation-id: conv_def
```

**Automatic Context Propagation:**

```typescript
// Headers automatically flow to:
// - Trace metadata
// - Cache keys
// - MemoryFn calls (if integrated)
// - Cost accounting
```

---

## 5. Repository Structure Improvements

### 5.1 Move Artifacts to .conduct

**Current:**
```
langfn/
├── SPEC.md (at root)
├── typescript/
└── python/
```

**Proposed:**
```
langfn/
├── .conduct/
│   ├── spec.md (moved from root)
│   └── improvements.spec.md (this document)
├── README.md (overview + quick start)
├── typescript/
└── python/
```

**Rationale:**
- Follows AGENTS.md convention
- Keeps root clean
- Groups planning/spec artifacts

### 5.2 Documentation Structure

**Proposed Docs Layout:**

```
langfn/docs/
├── getting-started.md
├── core-concepts/
│   ├── models.md
│   ├── prompts.md
│   ├── tools.md
│   └── chains-graphs.md
├── guides/
│   ├── streaming.md
│   ├── structured-outputs.md
│   ├── error-handling.md
│   ├── mcp-integration.md
│   └── evaluation.md
├── adapters/
│   ├── express.md
│   ├── fastify.md
│   ├── hono.md
│   ├── next.md
│   └── sveltekit.md
├── observability/
│   ├── watchfn.md
│   ├── cost-tracking.md
│   └── redaction.md
├── deployment/
│   ├── docker.md
│   ├── cloudflare-workers.md
│   └── production-checklist.md
└── api-reference/
```

---

## 6. Memory Integration with MemoryFn

### 6.1 Abstract Retriever Interface

**Keep in LangFn:**

```typescript
// Generic retriever interface
interface Retriever<T = any> {
  retrieve(query: string, options?: RetrieveOptions): Promise<T[]>;
}

// RAG chain accepts any retriever
const ragChain = lang.createRAGChain({
  retriever: myRetriever, // Can be memoryfn, custom, etc.
  prompt: template
});
```

### 6.2 MemoryFn Integration Example

**Using MemoryFn with LangFn:**

```typescript
import { langfn } from "langfn";
import { memoryfn } from "memoryfn";

const memory = memoryfn({
  storage: { kind: "pg", url: process.env.DATABASE_URL }
});

const lang = langfn({
  model: { provider: "openai", model: "gpt-4" }
});

// Use memoryfn as retriever
const ragChain = lang.createRAGChain({
  retriever: {
    retrieve: async (query) => {
      const results = await memory.search({
        q: query,
        containerTags: ["user:alice"],
        topK: 5
      });
      return results.map(r => r.content);
    }
  },
  prompt: template
});
```

**Clear Boundary:**
- LangFn provides orchestration and the Retriever abstraction
- MemoryFn provides the durable storage and retrieval implementation
- Clean separation enables independent evolution

---

## 7. De-scoped Features (Move to MemoryFn)

### Features to Remove from LangFn

1. **Vector Store Implementations**
   - `src/rag/vector-store.ts` → memoryfn
   - All vector DB adapters → memoryfn

2. **Long-Term Memory**
   - `src/memory/vector.ts` → memoryfn
   - `src/memory/entity.ts` → memoryfn
   - `src/memory/conversation.ts` → memoryfn (except ephemeral buffer)

3. **Document Indexing**
   - `src/rag/indexing.ts` → memoryfn
   - `src/rag/chunking.ts` → memoryfn (keep utility functions)

4. **Memory Deduplication and Merging**
   - Entire dedup/merge logic → memoryfn

### Features to Keep (Ephemeral Only)

1. **BufferMemory** - In-request message history
2. **SummaryMemory** - Single-request summarization
3. **Generic Retriever Interface** - Abstraction only

---

## 8. Testing and Quality

### 8.1 Integration with TestFn

**Evaluation Examples:**

```typescript
import { Evaluator } from "langfn/evaluation";
import { testfn } from "testfn";

const evaluator = new Evaluator({
  metrics: ["accuracy", "latency", "cost", "relevance"],
  datasets: testfn.loadDataset("qa-pairs")
});

const results = await evaluator.evaluate({
  model: lang,
  runs: 3
});

// Export to testfn for tracking
await testfn.report(results);
```

### 8.2 Provider Compatibility Tests

**Automated Provider Testing:**

```typescript
// Test all providers with same prompts
const providers = ["openai", "anthropic", "google", "groq"];

for (const provider of providers) {
  const lang = langfn({ model: { provider, model: "default" } });
  
  await runCompatibilityTests(lang);
}
```

---

## 9. Performance Optimizations

### 9.1 Connection Pooling

**Reuse HTTP Connections:**

```typescript
// Shared connection pool across requests
const lang = langfn({
  model: {
    provider: "openai",
    connectionPool: {
      maxConnections: 50,
      keepAlive: true,
      timeout: 30000
    }
  }
});
```

### 9.2 Request Batching

**Automatic Micro-batching:**

```typescript
// Multiple concurrent completions batched automatically
const [r1, r2, r3] = await Promise.all([
  lang.complete("Q1"),
  lang.complete("Q2"),
  lang.complete("Q3")
]);
// Batched into single provider request where possible
```

### 9.3 CacheFn Integration

**Optional Response Caching:**

```typescript
import { cachefn } from "cachefn";

const lang = langfn({
  cache: cachefn({
    storage: "indexeddb", // or "memory" or "redis"
    ttl: 3600,
    keyGenerator: (prompt, config) => {
      return `${config.model}:${hashPrompt(prompt)}`;
    }
  })
});

// Identical requests return cached responses
const r1 = await lang.complete("Capital of France?"); // Cache miss
const r2 = await lang.complete("Capital of France?"); // Cache hit
```

---

## 10. Security Enhancements

### 10.1 Secrets Management

**SecFn Integration:**

```typescript
import { getSecret } from "secfn";

const lang = langfn({
  model: {
    provider: "openai",
    apiKey: await getSecret("OPENAI_API_KEY") // Never hardcoded
  }
});
```

### 10.2 Input Validation

**Strict Schema Validation:**

```typescript
// All user inputs validated with Zod/Pydantic
const result = await lang.complete(userInput, {
  validation: {
    maxLength: 10000,
    allowedCharacters: /^[\w\s.,!?-]+$/,
    sanitize: true
  }
});
```

### 10.3 Output Sanitization

**Prevent Injection Attacks:**

```typescript
// Automatic sanitization of tool outputs
const result = await agent.run(userQuery, {
  sanitize: {
    html: true,
    sql: true,
    shell: true
  }
});
```

---

## 11. Migration Path

### Phase 1: Additive Changes (v1.1)
- Add MCP support
- Add structured outputs
- Add cost tracking
- Add enhanced errors
- Improve observability

### Phase 2: Memory Split (v2.0)
- Extract memory features to memoryfn
- Add Retriever abstraction
- Update docs and examples
- Deprecation warnings

### Phase 3: Cleanup (v2.1)
- Remove deprecated memory features
- Optimize bundle size
- Final API polish

---

## 12. Configuration Examples

### Minimal Configuration

```typescript
const lang = langfn({
  model: { provider: "openai", model: "gpt-4" }
});
```

### Production Configuration

```typescript
import { watchFn } from "watchfn";
import { getSecret } from "secfn";
import { cachefn } from "cachefn";

const lang = langfn({
  model: {
    provider: "openai",
    model: "gpt-4",
    apiKey: await getSecret("OPENAI_API_KEY"),
    temperature: 0.7,
    maxTokens: 2000
  },
  
  observability: {
    watchfn: watchFn({ name: "ai-app" }),
    traceAll: true,
    costMeter: new CostMeter({ providers: {...} }),
    redaction: ["email", "phone", "ssn"]
  },
  
  cache: cachefn({
    storage: "redis",
    url: process.env.REDIS_URL,
    ttl: 3600
  }),
  
  retry: {
    maxRetries: 3,
    backoff: "exponential",
    retryableErrors: [RateLimitError, TimeoutError]
  },
  
  rateLimit: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000
  },
  
  api: {
    enabled: true,
    auth: createAuthMiddleware({...}),
    cors: { origin: "https://myapp.com" }
  }
});
```

---

## 13. Summary of Changes

### High Priority (v1.1)
1. ✅ Add MCP client/server support
2. ✅ Add structured outputs layer
3. ✅ Implement unified streaming shape
4. ✅ Add cost tracking
5. ✅ Enhance error model
6. ✅ Add batch processing
7. ✅ Move SPEC.md to .conduct/

### Medium Priority (v1.2)
8. ✅ Add AbortSignal support
9. ✅ OpenTelemetry bridge
10. ✅ Redaction middleware
11. ✅ Multi-tenant headers
12. ✅ Connection pooling

### Low Priority (v2.0)
13. ✅ Extract memory features to memoryfn
14. ✅ Optimize bundle size
15. ✅ Enhanced documentation

---

## 14. Related Documents

- `langfn/SPEC.md` - Original specification
- `memoryfn/.conduct/spec.md` - Memory system specification
- `/AGENTS.md` - Repository conventions
- `langfn/.conduct/implementation.md` - Implementation plan (TBD)

---

**Last Updated**: 2026-01-13  
**Authors**: AI Agent (based on analysis of mem0, Letta, Supermemory, LangChain)  
**Status**: Proposal for Review
