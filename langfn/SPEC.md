# LangFn Specification

> Comprehensive AI Development SDK for LLM-based workflows

## Overview

LangFn is a unified AI development SDK that combines the best features of langchain, langgraph, langsmith, and langfuse into a single self-hosted platform. It provides orchestration, workflows, model abstraction, tools, observability, and prompt management for building production-grade LLM applications.

**Version**: 1.0.0  
**Target Release**: Q2 2026  
**Status**: Specification

## Core Philosophy

- **Unified SDK**: All AI workflow needs in one package
- **Self-hosted first**: Full data ownership, no vendor lock-in
- **Framework agnostic**: Works with any HTTP framework via superfunctions adapters
- **Type-safe**: First-class TypeScript support with full type inference
- **Observable by default**: Built-in integration with watchfn for monitoring
- **Model agnostic**: Support for OpenAI, Anthropic, Google, local models, and more
- **Developer-centric**: Simple APIs, great DX, minimal configuration
- **Production-ready**: Streaming, retries, error handling, rate limiting built-in

## Architecture

```
langfn/
├── .conduct/                         # Artifacts
│   └── SPEC.md
├── README.md
│
├── typescript/                       # TypeScript SDK
│   ├── package.json                  # Package: langfn
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts
│   │   ├── core/
│   │   │   ├── langfn.ts             # Main SDK entry
│   │   │   ├── context.ts            # Execution context
│   │   │   └── config.ts             # Configuration types
│   │   ├── models/
│   │   │   ├── base.ts               # Base model interface
│   │   │   ├── chat.ts               # Chat completion models
│   │   │   ├── completion.ts         # Text completion models
│   │   │   ├── embedding.ts          # Embedding models
│   │   │   └── providers/
│   │   │       ├── openai.ts
│   │   │       ├── anthropic.ts
│   │   │       ├── google.ts
│   │   │       ├── mistral.ts
│   │   │       ├── ollama.ts         # Local models
│   │   │       └── custom.ts
│   │   ├── orchestration/
│   │   │   ├── chain.ts              # Sequential chains
│   │   │   ├── router.ts             # Dynamic routing
│   │   │   ├── parallel.ts           # Parallel execution
│   │   │   ├── map.ts                # Map-reduce patterns
│   │   │   └── conditional.ts        # Conditional logic
│   │   ├── graph/
│   │   │   ├── workflow.ts           # Graph-based workflows
│   │   │   ├── node.ts               # Workflow nodes
│   │   │   ├── edge.ts               # Workflow edges
│   │   │   ├── state.ts              # State management
│   │   │   ├── executor.ts           # Graph execution engine
│   │   │   └── visualizer.ts         # Workflow visualization
│   │   ├── prompts/
│   │   │   ├── template.ts           # Prompt templates
│   │   │   ├── few-shot.ts           # Few-shot learning
│   │   │   ├── messages.ts           # Message formatting
│   │   │   ├── chat-template.ts      # Chat prompt templates
│   │   │   ├── registry.ts           # Prompt management
│   │   │   └── versioning.ts         # Prompt versioning
│   │   ├── tools/
│   │   │   ├── base.ts               # Tool interface
│   │   │   ├── function-calling.ts   # Function calling
│   │   │   ├── schema.ts             # Tool schemas (Zod)
│   │   │   ├── executor.ts           # Tool execution
│   │   │   └── builtin/
│   │   │       ├── web-search.ts
│   │   │       ├── calculator.ts
│   │   │       ├── code-exec.ts
│   │   │       └── api-call.ts
│   │   ├── memory/
│   │   │   ├── buffer.ts             # Buffer memory
│   │   │   ├── summary.ts            # Summary memory
│   │   │   ├── vector.ts             # Vector store memory
│   │   │   ├── conversation.ts       # Conversation history
│   │   │   └── entity.ts             # Entity memory
│   │   ├── rag/
│   │   │   ├── retriever.ts          # Document retrieval
│   │   │   ├── embeddings.ts         # Vector embeddings
│   │   │   ├── vector-store.ts       # Vector database
│   │   │   ├── chunking.ts           # Text chunking
│   │   │   ├── reranking.ts          # Result reranking
│   │   │   └── indexing.ts           # Document indexing
│   │   ├── agents/
│   │   │   ├── base.ts               # Base agent
│   │   │   ├── react.ts              # ReAct agent
│   │   │   ├── plan-execute.ts       # Plan-and-execute
│   │   │   ├── conversational.ts     # Conversational agent
│   │   │   ├── multi-agent.ts        # Multi-agent systems
│   │   │   └── tool-agent.ts         # Tool-using agent
│   │   ├── observability/
│   │   │   ├── tracer.ts             # Execution tracing
│   │   │   ├── logger.ts             # Structured logging
│   │   │   ├── metrics.ts            # Performance metrics
│   │   │   ├── watchfn-integration.ts # WatchFn integration
│   │   │   └── feedback.ts           # User feedback collection
│   │   ├── storage/
│   │   │   ├── database.ts           # Uses @superfunctions/db
│   │   │   ├── cache.ts              # Response caching
│   │   │   └── persistence.ts        # State persistence
│   │   ├── streaming/
│   │   │   ├── stream.ts             # Streaming responses
│   │   │   ├── sse.ts                # Server-sent events
│   │   │   └── websocket.ts          # WebSocket streaming
│   │   ├── http/
│   │   │   ├── router.ts             # Generic HTTP router (framework-agnostic)
│   │   │   └── handlers.ts           # Request handlers
│   │   │   # Note: Uses @superfunctions/http-* adapters, not bundled
│   │   ├── evaluation/
│   │   │   ├── evaluator.ts          # Model evaluation
│   │   │   ├── metrics.ts            # Evaluation metrics
│   │   │   ├── datasets.ts           # Test datasets
│   │   │   └── experiments.ts        # A/B testing
│   │   └── utils/
│   │       ├── retry.ts              # Retry logic
│   │       ├── rate-limit.ts         # Rate limiting
│   │       ├── token-counter.ts      # Token counting
│   │       └── validation.ts         # Input validation
│   ├── examples/
│   └── tests/
│
├── python/                           # Python SDK
│   ├── pyproject.toml                # Package: langfn
│   ├── README.md
│   ├── langfn/
│   │   ├── __init__.py
│   │   ├── client.py
│   │   ├── models.py
│   │   ├── core/
│   │   ├── models/
│   │   ├── orchestration/
│   │   ├── graph/
│   │   ├── prompts/
│   │   ├── tools/
│   │   ├── memory/
│   │   ├── rag/
│   │   ├── agents/
│   │   ├── observability/
│   │   ├── storage/
│   │   ├── streaming/
│   │   ├── http/                     # HTTP router (uses superfunctions-fastapi/flask adapters)
│   │   ├── evaluation/
│   │   └── utils/
│   └── tests/
│
└── docs/                             # Documentation
    ├── getting-started.md
    ├── guides/
    └── api/
```

## Technology Stack

### TypeScript SDK

- **Language:** TypeScript 5.x (ESM-first)
- **Package Name:** `langfn` (simple name, not scoped)
- **Build:** tsup for bundling
- **Testing:** Vitest with coverage
- **Validation:** Zod schemas for runtime type safety

### Python SDK

- **Language:** Python 3.10+
- **Package Name:** `langfn` (simple name, not scoped)
- **Validation:** Pydantic v2 for data models
- **Build:** hatch or poetry
- **Testing:** pytest with coverage

### Dependencies

**TypeScript (`typescript/package.json`):**

```json
{
  "name": "langfn",
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
    "watchfn": "workspace:*"
  }
}
```

**Python (`python/pyproject.toml`):**

```toml
[project]
name = "langfn"
dependencies = [
  "superfunctions>=0.1.0",
  "pydantic>=2.6",
  "httpx>=0.27",
  "tiktoken>=0.7"
]

[project.optional-dependencies]
fastapi = ["superfunctions-fastapi>=0.1.0"]
flask = ["superfunctions-flask>=0.1.0"]
watchfn = ["watchfn>=1.0.0"]
openai = ["openai>=1.0"]
anthropic = ["anthropic>=0.25"]
google = ["google-generativeai>=0.3"]
```

## Core Features

### 1. Model Abstraction

Unified interface for all LLM providers with consistent APIs.

**TypeScript:**

```typescript
import { langfn } from "langfn";

const lang = langfn({
  model: {
    provider: "openai",
    model: "gpt-4",
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0.7,
  },
  observability: {
    enabled: true,
    watchfn: watchInstance, // Optional watchfn integration
  },
});

// Simple completion
const response = await lang.complete("What is the capital of France?");

// Chat completion
const chatResponse = await lang.chat([
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Explain quantum computing" },
]);

// Streaming
for await (const chunk of lang.stream("Tell me a story")) {
  process.stdout.write(chunk.content);
}

// Multiple providers
const anthropicModel = lang.withModel({
  provider: "anthropic",
  model: "claude-3-opus",
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const localModel = lang.withModel({
  provider: "ollama",
  model: "llama2",
  baseUrl: "http://localhost:11434",
});
```

**Python:**

```python
from langfn import LangFn

lang = LangFn(
    model={
        "provider": "openai",
        "model": "gpt-4",
        "api_key": os.getenv("OPENAI_API_KEY"),
        "temperature": 0.7,
    },
    observability={"enabled": True}
)

# Simple completion
response = await lang.complete("What is the capital of France?")

# Streaming
async for chunk in lang.stream("Tell me a story"):
    print(chunk.content, end="")
```

### 2. Prompt Management

Template-based prompt management with versioning and registry.

```typescript
import { PromptTemplate } from "langfn/prompts";

// Simple template
const greetingPrompt = new PromptTemplate({
  template: "Hello {name}, welcome to {place}!",
  variables: ["name", "place"],
});

const formatted = greetingPrompt.format({ name: "Alice", place: "Wonderland" });

// Chat template
const chatPrompt = new ChatTemplate({
  messages: [
    { role: "system", content: "You are a {role}." },
    { role: "user", content: "{query}" },
  ],
});

const messages = chatPrompt.format({
  role: "senior software engineer",
  query: "How do I optimize React performance?",
});

// Few-shot prompts
const fewShotPrompt = new FewShotPrompt({
  prefix: "Translate English to French:",
  examples: [
    { input: "Hello", output: "Bonjour" },
    { input: "Goodbye", output: "Au revoir" },
  ],
  suffix: "Input: {input}\nOutput:",
});

// Prompt registry with versioning
const registry = lang.prompts.createRegistry({
  storage: dbAdapter,
});

await registry.save("greeting-v1", greetingPrompt, {
  version: "1.0.0",
  description: "Basic greeting template",
  tags: ["greetings", "onboarding"],
});

const loadedPrompt = await registry.load("greeting-v1", { version: "1.0.0" });
```

### 3. Tools & Function Calling

Define tools with Zod schemas for function calling.

```typescript
import { Tool } from "langfn/tools";
import { z } from "zod";

// Define a tool
const weatherTool = new Tool({
  name: "get_weather",
  description: "Get current weather for a location",
  schema: z.object({
    location: z.string().describe("City name or zip code"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  execute: async ({ location, unit }) => {
    const weather = await fetchWeather(location, unit);
    return { temperature: weather.temp, conditions: weather.conditions };
  },
});

// Use with model
const response = await lang.chat(
  [{ role: "user", content: "What is the weather in Paris?" }],
  {
    tools: [weatherTool],
    toolChoice: "auto",
  }
);

// Multi-step tool calling
const agent = lang.createToolAgent({
  tools: [weatherTool, calculatorTool, searchTool],
  maxIterations: 5,
});

const result = await agent.run("Compare the weather in Paris and London");
```

### 4. Chains & Orchestration

Sequential and parallel execution patterns.

```typescript
import { Chain } from "langfn/orchestration";

// Sequential chain
const summaryChain = Chain.sequential([
  async (input) => {
    const response = await lang.complete(`Extract key points from: ${input}`);
    return response.content;
  },
  async (keyPoints) => {
    const response = await lang.complete(
      `Summarize these points: ${keyPoints}`
    );
    return response.content;
  },
]);

const summary = await summaryChain.run(longDocument);

// Parallel execution
const parallelChain = Chain.parallel([
  async (input) => lang.complete(`Sentiment: ${input}`),
  async (input) => lang.complete(`Topics: ${input}`),
  async (input) => lang.complete(`Keywords: ${input}`),
]);

const [sentiment, topics, keywords] = await parallelChain.run(text);

// Map-reduce pattern
const mapReduceChain = Chain.mapReduce({
  map: async (chunk) => {
    const response = await lang.complete(`Summarize: ${chunk}`);
    return response.content;
  },
  reduce: async (summaries) => {
    const combined = summaries.join("\n\n");
    const response = await lang.complete(`Final summary: ${combined}`);
    return response.content;
  },
});

const finalSummary = await mapReduceChain.run(textChunks);

// Router chain (dynamic routing)
const routerChain = Chain.router({
  routes: {
    technical: async (input) => await techChain.run(input),
    business: async (input) => await businessChain.run(input),
    creative: async (input) => await creativeChain.run(input),
  },
  router: async (input) => {
    const response = await lang.complete(
      `Classify this query as technical/business/creative: ${input}`
    );
    return response.content.toLowerCase();
  },
});

const result = await routerChain.run(userQuery);
```

### 5. Graph Workflows (LangGraph-style)

Build complex, stateful workflows with conditional logic.

```typescript
import { Workflow, StateGraph } from "langfn/graph";

// Define state
interface AgentState {
  messages: Message[];
  nextAction: "call_tool" | "respond" | "end";
  toolResults: any[];
}

// Create workflow graph
const workflow = new StateGraph<AgentState>({
  initialState: {
    messages: [],
    nextAction: "respond",
    toolResults: [],
  },
});

// Add nodes
workflow.addNode("agent", async (state) => {
  const response = await lang.chat(state.messages, {
    tools: availableTools,
  });

  if (response.toolCalls) {
    return {
      ...state,
      nextAction: "call_tool",
      messages: [...state.messages, response],
    };
  }

  return {
    ...state,
    nextAction: "respond",
    messages: [...state.messages, response],
  };
});

workflow.addNode("tools", async (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const results = await Promise.all(
    lastMessage.toolCalls.map((call) => executeToolCall(call))
  );

  return { ...state, toolResults: results, nextAction: "respond" };
});

workflow.addNode("respond", async (state) => {
  const finalResponse = state.messages[state.messages.length - 1];
  return { ...state, nextAction: "end" };
});

// Add conditional edges
workflow.addConditionalEdge("agent", (state) => state.nextAction);
workflow.addEdge("tools", "agent");
workflow.addEdge("respond", "__end__");

// Set entry point
workflow.setEntryPoint("agent");

// Compile and run
const app = workflow.compile();
const result = await app.invoke({
  messages: [
    { role: "user", content: "What is 25 * 4 and what is the weather?" },
  ],
});
```

### 6. RAG (Retrieval-Augmented Generation)

Document indexing, retrieval, and generation.

```typescript
import { VectorStore, Embeddings } from "langfn/rag";

// Create embeddings
const embeddings = new Embeddings({
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: process.env.OPENAI_API_KEY,
});

// Create vector store
const vectorStore = new VectorStore({
  embeddings,
  storage: dbAdapter,
  namespace: "documents",
});

// Index documents
await vectorStore.addDocuments([
  { content: "Paris is the capital of France.", metadata: { source: "wiki" } },
  { content: "The Eiffel Tower is in Paris.", metadata: { source: "wiki" } },
]);

// Search
const results = await vectorStore.search("What is the capital of France?", {
  topK: 3,
  filter: { source: "wiki" },
});

// RAG chain
const ragChain = lang.createRAGChain({
  retriever: vectorStore.asRetriever({ topK: 3 }),
  prompt: new PromptTemplate({
    template: `Answer the question based on the context.
    
Context: {context}

Question: {question}

Answer:`,
  }),
});

const answer = await ragChain.run({
  question: "Tell me about Paris",
});
```

### 7. Agents

Pre-built agent patterns (ReAct, Plan-Execute, etc.).

```typescript
import { ReActAgent, PlanExecuteAgent } from "langfn/agents";

// ReAct agent
const reactAgent = new ReActAgent({
  model: lang,
  tools: [searchTool, calculatorTool, weatherTool],
  maxIterations: 10,
  verbose: true,
});

const result = await reactAgent.run(
  "What is the population of Paris multiplied by the current temperature there?"
);

// Plan and execute agent
const planExecuteAgent = new PlanExecuteAgent({
  model: lang,
  tools: [searchTool, calculatorTool],
  planner: async (goal) => {
    const response = await lang.complete(
      `Create a step-by-step plan for: ${goal}`
    );
    return parsePlan(response.content);
  },
  executor: async (step) => {
    return await executeStep(step);
  },
});

const result = await planExecuteAgent.run(
  "Research and compare GDP of top 5 countries"
);

// Multi-agent collaboration
const researchAgent = new ReActAgent({
  tools: [searchTool],
  role: "researcher",
});
const writerAgent = new ReActAgent({ tools: [draftTool], role: "writer" });

const multiAgentWorkflow = new MultiAgentWorkflow({
  agents: { researcher: researchAgent, writer: writerAgent },
  coordinator: async (task, results) => {
    // Decide which agent to use next
    return "researcher";
  },
});
```

### 8. Memory Management

Conversation history and context management.

```typescript
import { BufferMemory, SummaryMemory, VectorMemory } from "langfn/memory";

// Buffer memory (simple conversation history)
const bufferMemory = new BufferMemory({
  maxMessages: 10,
});

await bufferMemory.add({ role: "user", content: "Hello" });
await bufferMemory.add({ role: "assistant", content: "Hi there!" });

const history = await bufferMemory.get();

// Summary memory (compress old conversations)
const summaryMemory = new SummaryMemory({
  model: lang,
  maxTokens: 1000,
  summaryPrompt: "Summarize this conversation:",
});

// Vector memory (semantic search over history)
const vectorMemory = new VectorMemory({
  embeddings,
  storage: dbAdapter,
  topK: 5,
});

// Entity memory (track entities across conversation)
const entityMemory = new EntityMemory({
  model: lang,
  storage: dbAdapter,
});

// Use with chains
const conversationChain = lang.createConversationChain({
  memory: summaryMemory,
  prompt: chatPrompt,
});
```

### 9. Observability & Tracing

Built-in observability with WatchFn integration.

```typescript
import { langfn } from "langfn";
import { watchFn } from "watchfn";

const watch = watchFn({ name: "ai-app" });

const lang = langfn({
  model: { provider: "openai", model: "gpt-4" },
  observability: {
    enabled: true,
    watchfn: watch, // Automatic integration
    traceAll: true,
    logPrompts: true,
    logResponses: true,
  },
});

// All operations are automatically traced
const response = await lang.complete("Hello");

// Query traces
const traces = await lang.observability.getTraces({
  timeRange: "last-24h",
  model: "gpt-4",
});

// Track custom metrics
await lang.observability.track("custom_metric", {
  value: 42,
  metadata: { user: "alice" },
});

// Collect user feedback
await lang.observability.feedback({
  traceId: response.traceId,
  rating: 5,
  comment: "Great response!",
});

// View in WatchFn dashboard
// - Token usage per model
// - Latency percentiles
// - Error rates
// - Cost tracking
// - User feedback
```

### 10. Streaming

Real-time streaming responses.

```typescript
import { langfn } from "langfn";

// Async iterator streaming
for await (const chunk of lang.stream("Tell me a long story")) {
  process.stdout.write(chunk.content);
}

// SSE (Server-Sent Events)
app.get("/chat", async (req, res) => {
  const stream = lang.streamSSE(req.query.message);

  for await (const event of stream) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.end();
});

// WebSocket streaming
io.on("connection", (socket) => {
  socket.on("message", async (message) => {
    for await (const chunk of lang.stream(message)) {
      socket.emit("chunk", chunk);
    }
    socket.emit("done");
  });
});

// Streaming with tools
for await (const chunk of lang.stream("What is the weather?", {
  tools: [weatherTool],
})) {
  if (chunk.type === "tool_call") {
    console.log("Calling tool:", chunk.toolName);
  } else if (chunk.type === "content") {
    process.stdout.write(chunk.content);
  }
}
```

### 11. Evaluation & Experimentation

Test and compare model outputs.

```typescript
import { Evaluator } from "langfn/evaluation";

// Create test dataset
const dataset = [
  {
    input: "What is 2+2?",
    expected: "4",
    metadata: { category: "math" },
  },
  {
    input: "What is the capital of France?",
    expected: "Paris",
    metadata: { category: "geography" },
  },
];

// Define evaluator
const evaluator = new Evaluator({
  metrics: ["accuracy", "latency", "token_count", "cost"],
  customMetrics: [
    {
      name: "contains_answer",
      fn: (output, expected) => output.includes(expected),
    },
  ],
});

// Run evaluation
const results = await evaluator.evaluate({
  model: lang,
  dataset,
  runs: 3, // Run each test 3 times
});

console.log(results);
// {
//   accuracy: 0.95,
//   avgLatency: 234ms,
//   avgTokens: 45,
//   totalCost: 0.0023,
//   perCategory: { math: {...}, geography: {...} }
// }

// A/B testing
const experiment = await evaluator.compare({
  models: [
    { name: "gpt-4", config: { provider: "openai", model: "gpt-4" } },
    { name: "claude-3", config: { provider: "anthropic", model: "claude-3" } },
  ],
  dataset,
  metrics: ["accuracy", "cost", "latency"],
});
```

### 12. HTTP API Integration

Optional HTTP endpoints for remote access.

```typescript
import express from "express";
import { langfn } from "langfn";
import { createLangFnRouter } from "langfn/http";
import { createExpressAdapter } from "@superfunctions/http-express";

const app = express();
const lang = langfn({
  model: { provider: "openai", model: "gpt-4" },
  api: {
    enabled: true,
    auth: {
      apiKey: process.env.LANGFN_API_KEY,
    },
  },
});

// Mount API routes using @superfunctions/http-express adapter
app.use("/ai", createLangFnRouter(lang, {
  adapter: createExpressAdapter()
}));

// Endpoints available:
// POST /ai/complete - Text completion
// POST /ai/chat - Chat completion
// POST /ai/stream - Streaming completion
// POST /ai/embed - Generate embeddings
// GET  /ai/traces - Get execution traces
// POST /ai/feedback - Submit feedback
```

### 13. Caching & Performance

Response caching and optimization.

```typescript
const lang = langfn({
  model: { provider: "openai", model: "gpt-4" },
  cache: {
    enabled: true,
    storage: dbAdapter,
    ttl: 3600, // 1 hour
    keyGenerator: (prompt, config) => {
      return `${config.model}:${hashPrompt(prompt)}`;
    },
  },
  retry: {
    maxRetries: 3,
    backoff: "exponential",
  },
  rateLimit: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
  },
});

// First call hits API
const response1 = await lang.complete("Capital of France?");

// Second identical call returns cached result
const response2 = await lang.complete("Capital of France?");
```

## Database Schema

Using `@superfunctions/db` adapters, langfn requires these tables:

```typescript
// Prompt registry
interface PromptRecord {
  id: string;
  name: string;
  version: string;
  template: string;
  variables: string[];
  description?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// Execution traces
interface TraceRecord {
  id: string;
  startTime: number;
  endTime: number;
  model: string;
  provider: string;
  input: string;
  output: string;
  tokens: { prompt: number; completion: number; total: number };
  latency: number;
  cost?: number;
  metadata: Record<string, unknown>;
  userId?: string;
}

// Vector store
interface DocumentRecord {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  namespace: string;
  createdAt: number;
}

// Memory
interface ConversationRecord {
  id: string;
  sessionId: string;
  messages: Message[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

// Cache
interface CacheRecord {
  key: string;
  value: string;
  expiresAt: number;
  createdAt: number;
}
```

## Python SDK Examples

```python
from langfn import LangFn
from langfn.prompts import PromptTemplate
from langfn.tools import Tool
from langfn.agents import ReActAgent

# Initialize
lang = LangFn(
    model={"provider": "openai", "model": "gpt-4"},
    observability={"enabled": True}
)

# Simple completion
response = await lang.complete("Hello!")

# Chat
messages = [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Hi"}
]
response = await lang.chat(messages)

# Streaming
async for chunk in lang.stream("Tell me a story"):
    print(chunk.content, end="")

# Tools
weather_tool = Tool(
    name="get_weather",
    description="Get weather for location",
    schema={
        "type": "object",
        "properties": {
            "location": {"type": "string"}
        }
    },
    execute=lambda location: get_weather_data(location)
)

# Agent
agent = ReActAgent(model=lang, tools=[weather_tool])
result = await agent.run("What's the weather in Paris?")
```

## Deployment

```bash
# TypeScript
npm install langfn @superfunctions/db @superfunctions/http

# Python
pip install langfn[fastapi,openai,anthropic]
```

## Verification Plan

### Automated Tests

1. **Unit tests** - Test individual components

   ```bash
   npm test --workspace=langfn
   pytest langfn/python/tests/
   ```

2. **Integration tests** - Test model providers, tools, chains
3. **E2E tests** - Test complete workflows

### Manual Testing

1. Build example applications using langfn
2. Test with multiple LLM providers
3. Verify WatchFn integration
4. Test streaming in browser/server environments

## License

MIT

---

**Last Updated**: 2026-01-13  
**Status**: Specification  
**Authors**: 21n Team
