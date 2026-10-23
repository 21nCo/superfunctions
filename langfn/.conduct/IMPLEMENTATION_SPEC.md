# LangFn Implementation Specification

> Detailed implementation guide for LangFn - The Superfunctions AI SDK

**Status**: Planning
**Version**: 1.0.0
**Related**: `../SPEC.md`, `../../AGENTS.md`

## 1. Executive Summary

LangFn is a comprehensive AI development SDK designed to unify the capabilities of **LangChain** (model abstraction, chains), **LangGraph** (stateful workflows), **LangSmith/LangFuse** (observability, evaluation, prompt management) into a single, cohesive library.

It follows the **Superfunctions** pattern:
- **Monorepo-native**: Lives in `langfn/`
- **Dual SDKs**: TypeScript (`langfn/typescript`) and Python (`langfn/python`)
- **Shared Infrastructure**: Uses `@superfunctions/http` for API routes, `@superfunctions/db` for storage
- **Observability**: Native integration with `watchfn`

## 2. Architecture & Directory Structure

Adhering to `AGENTS.md` patterns.

### 2.1 TypeScript SDK (`langfn/typescript`)

```
langfn/typescript/
├── package.json          # name: "langfn"
├── tsconfig.json
├── tsup.config.ts        # Bundle configuration
├── vitest.config.ts      # Test configuration
├── src/
│   ├── index.ts          # Main export
│   ├── client.ts         # LangFn client
│   ├── core/             # Core types and interfaces
│   ├── models/           # Model providers (OpenAI, Anthropic, etc.)
│   ├── prompts/          # Prompt templates & registry
│   ├── tools/            # Tool definition & execution
│   ├── orchestration/    # Chains, Router
│   ├── graph/            # StateGraph, Workflows (LangGraph-style)
│   ├── agents/           # ReAct, Plan-Execute
│   ├── memory/           # Conversation history, Vector memory
│   ├── rag/              # Embeddings, Vector Stores
│   ├── observability/    # Tracing, WatchFn integration
│   ├── evaluation/       # Datasets, Evaluators
│   ├── http/             # HTTP Router (uses @superfunctions/http)
│   └── storage/          # Database adapters (uses @superfunctions/db)
└── tests/
```

### 2.2 Python SDK (`langfn/python`)

```
langfn/python/
├── pyproject.toml        # name: "langfn"
├── README.md
├── langfn/
│   ├── __init__.py
│   ├── client.py
│   ├── core/
│   ├── models/
│   ├── prompts/
│   ├── tools/
│   ├── orchestration/
│   ├── graph/
│   ├── agents/
│   ├── memory/
│   ├── rag/
│   ├── observability/
│   ├── evaluation/
│   ├── http/             # HTTP Routes (FastAPI/Flask adapters via superfunctions-*)
│   └── storage/
└── tests/
```

## 3. Core Modules & Features

### 3.1 Model Abstraction (`models/`)

**Goal**: Unified interface for chat, completion, and embedding models.
**Inspiration**: LangChain `BaseLanguageModel`

- **Interfaces**:
  - `ChatModel`: `chat(messages) -> ChatResponse`
  - `CompletionModel`: `complete(prompt) -> CompletionResponse`
  - `EmbeddingModel`: `embed(text) -> number[]`
- **Features**:
  - Unified `Message` types (System, User, Assistant, Tool)
  - Streaming support (`stream()` returning async iterator)
  - Token counting
  - Retries & Rate Limiting (via `utils/retry`)
- **Providers**: OpenAI, Anthropic, Google, Mistral, Ollama (Local).

### 3.2 Prompt Management (`prompts/`)

**Goal**: Type-safe templates and centralized registry.
**Inspiration**: LangHub, LangFuse

- **Templates**: `PromptTemplate`, `ChatPromptTemplate`.
  - Support for `{{variable}}` syntax.
  - Partial application.
- **Registry**:
  - Load/Save prompts to DB/File.
  - Versioning (`v1`, `v1.0.1`, `latest`).
  - Metadata (tags, description).

### 3.3 Tools & Function Calling (`tools/`)

**Goal**: Standardized tool definition for agents and LLMs.
**Inspiration**: LangChain Tools, OpenAI Functions

- **Structure**:
  - `name`: Unique identifier.
  - `description`: Natural language description.
  - `schema`: Zod (TS) / Pydantic (Python) schema for arguments.
  - `execute`: Async function implementation.
- **Integration**:
  - Auto-conversion to OpenAI `functions` / `tools` format.
  - Middleware support (logging, validation).

### 3.4 Orchestration (`orchestration/`)

**Goal**: Simple sequential and parallel execution patterns.
**Inspiration**: LangChain Chains

- **Chain**:
  - `Chain.sequential([step1, step2])`
  - `Chain.parallel([step1, step2])`
  - `Chain.mapReduce()`
- **Router**: Dynamic routing based on input classification.

### 3.5 Graph Workflows (`graph/`)

**Goal**: Complex, cyclic, stateful workflows.
**Inspiration**: LangGraph

- **Components**:
  - `StateGraph`: The graph definition.
  - `Node`: A function processing state.
  - `Edge`: Transitions (Static or Conditional).
  - `State`: Typed state object passed between nodes.
- **Features**:
  - Checkpointing (save/resume state).
  - Human-in-the-loop (interrupt before/after nodes).
  - Visualization (export to mermaid/json).

### 3.6 Agents (`agents/`)

**Goal**: Pre-built architectures for autonomous tasks.

- **Types**:
  - `ReActAgent`: Reasoning + Acting loop.
  - `ToolAgent`: Simple tool-using agent.
  - `PlanExecuteAgent`: Planning phase followed by execution.
- **Interface**: `agent.run(input) -> result`

### 3.7 Observability (`observability/`)

**Goal**: Full visibility into execution.
**Inspiration**: LangSmith, LangFuse

- **Tracing**:
  - Trace ID propagation.
  - Spans for Chain, LLM, Tool, Retrieval.
- **WatchFn Integration**:
  - Push traces to `watchfn` for visualization.
  - Metrics (Tokens, Latency, Cost).
- **Feedback**: Allow attaching user feedback to traces.

### 3.8 Memory & RAG (`memory/`, `rag/`)

**Goal**: Context retention and knowledge retrieval.

- **Memory**:
  - `BufferMemory`: Raw list of messages.
  - `SummaryMemory`: LLM-summarized history.
  - `VectorMemory`: Semantic search over history.
- **RAG**:
  - `Document`: Text + Metadata.
  - `VectorStore`: Interface for generic vector DBs.
  - `Retriever`: Interface for fetching documents.

## 4. Superfunctions Ecosystem Integration

### 4.1 HTTP Adapters
LangFn does **not** bind to a specific framework. It uses `@superfunctions/http`.

- **TS**: `createLangFnRouter(lang, { adapter: ... })`
  - Users install `@superfunctions/http-express` or `http-next` themselves.
- **Python**: `langfn.http.create_router(lang, adapter=...)`
  - Users install `superfunctions-fastapi` or `flask` themselves.

### 4.2 Database
Storage for Prompts, Traces, and Memory uses `@superfunctions/db`.

- Tables: `langfn_prompts`, `langfn_traces`, `langfn_sessions`.
- Users provide the DB instance (Drizzle/Prisma/SQLAlchemy).

## 5. Implementation Roadmap

### Phase 1: Foundation (Current - Python Partial)
- [x] Python: Core Client, Models (OpenAI), Basic Tools.
- [ ] TypeScript: Scaffolding, Core Types, Client.
- [ ] Both: Observability (Logging/Tracing types).

### Phase 2: Orchestration & Graph
- [ ] Python: Finish `StateGraph` implementation.
- [ ] TypeScript: Implement `Chain` and `StateGraph`.

### Phase 3: Agents & Tools
- [ ] Both: ReAct Agent, robust Tool definitions (Zod/Pydantic).
- [ ] Both: Standard Toolset (Calculator, WebSearch).

### Phase 4: Superfunctions Integration
- [ ] TypeScript: `@superfunctions/http` router implementation.
- [ ] Python: `superfunctions-fastapi` router implementation.
- [ ] Both: `watchfn` exporter.

### Phase 5: Advanced Features
- [ ] RAG (Vector Stores).
- [ ] Evaluation Framework.
- [ ] Prompt Registry (DB backed).

## 6. Development Standards

- **Types**: Strict typing. No `any` (TS) or untyped (Python) unless absolutely necessary.
- **Testing**:
  - TS: `vitest` (Unit + Integration).
  - Python: `pytest` (Asyncio).
- **Conventions**:
  - Class-based for major components (Models, Chains).
  - Functional for utilities.
  - Builders/Fluent APIs where appropriate.

## 7. Next Steps

1. **Scaffold TypeScript SDK**: Initialize `langfn/typescript`.
2. **Audit Python SDK**: Check current state vs SPEC, fill gaps (especially `watchfn` integration).
3. **Implement HTTP Layer**: Enable exposing agents via API.
