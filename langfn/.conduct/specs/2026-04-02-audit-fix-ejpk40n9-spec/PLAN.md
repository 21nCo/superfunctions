# Architecture sketch

## Core modules

- `langfn/typescript/src/core/`
  - shared types
  - canonical error model
  - config normalization
- `langfn/typescript/src/models/`
  - provider SPI
  - provider adapters
  - pooled transport helpers
- `langfn/typescript/src/prompts/`
  - templates
  - registry
  - structured outputs
- `langfn/typescript/src/tools/`
  - canonical tool spec
  - builtin tool factories
  - safety policy helpers
- `langfn/typescript/src/orchestration/`
  - sequential/parallel/map-reduce/router primitives
- `langfn/typescript/src/graph/`
  - state graph, checkpointing, interrupts, exports
- `langfn/typescript/src/agents/`
  - ToolAgent, ReActAgent, PlanExecuteAgent, multi-agent coordinator
- `langfn/typescript/src/memory/` and `langfn/typescript/src/rag/`
  - ephemeral memory
  - retriever abstractions
  - reference vector stores
  - memoryfn integration adapters
- `langfn/typescript/src/observability/`
  - tracing
  - storage
  - watchfn/OTLP export
  - cost/budget/redaction
- `langfn/typescript/src/http/`
  - canonical route builders
  - auth/rate-limit/context wiring
- `langfn/typescript/src/mcp/`
  - MCP client/server/transports

Equivalent Python module groups MUST exist under `langfn/python/langfn/`.

## Dependency graph

1. Packaging/export contract MUST land before all downstream runtime work.
2. Core types, errors, config normalization, and provider SPI MUST land before provider adapters, tools, agents, HTTP, and MCP.
3. Prompt/structured-output contract MUST land before agent, tool, and evaluation parity work.
4. Tool normalization MUST land before agent loops and HTTP chat/tool routes.
5. Trace/storage primitives MUST land before feedback, budgets, and release gates.
6. Retriever boundary resolution MUST land before scalable RAG and memoryfn integration.
7. HTTP auth/rate-limiting MUST land before declaring production readiness.
8. Release gates and docs MUST be the final phase because they validate all previous phases.

# Phases overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| Phase 00 | Repair package contracts and build/test scaffolding | valid package names, exports, versions, docs scaffolding | repo-root import/build smoke tests |
| Phase 01 | Stabilize core client and provider substrate | parity client APIs, provider SPI, normalized errors, retries, cancellation | deterministic provider and API tests |
| Phase 02 | Fix prompt/registry/structured-output parity | public exports, deterministic prompt registry, schema parsing | prompt and structured-output suites |
| Phase 03 | Repair tool-calling and safe builtins | provider-native tool schemas, secure tool execution | tool agent and builtin policy tests |
| Phase 04 | Complete orchestration, graph, and agents | router, checkpoints, ReAct, ToolAgent, PlanExecute, multi-agent | orchestration/graph/agent suites |
| Phase 05 | Complete memory and RAG boundary | ephemeral memory, retrievers, reference stores, memoryfn integration | retriever/RAG suites |
| Phase 06 | Complete streaming and observability | unified stream events, trace storage, feedback, watchfn, budgets, redaction | stream/trace/feedback suites |
| Phase 07 | Harden HTTP security surface | complete/chat/stream/embed/traces/feedback routes with auth and rate limits | HTTP integration suites |
| Phase 08 | Add MCP and evaluation parity | MCP stdio/SSE, evaluator/compare/testfn hooks | MCP and evaluation suites |
| Phase 09 | Deliver performance and scalability fixes | pooling, cachefn integration, scalable retrieval, duplication reduction | perf/architecture release gates |
| Phase 10 | Ship docs, examples, and release gates | runnable docs, provider compatibility matrix, full release gate | end-to-end release gate |

# Definition of Done

No phase is complete unless its verification steps pass.
