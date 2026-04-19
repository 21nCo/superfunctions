# LangFn Release Contract

LangFn `0.1.0` is the Superfunctions dual-language SDK for production LLM workflows.

## Published surfaces

TypeScript:

- `langfn`
- `langfn/models`
- `langfn/prompts`
- `langfn/tools`
- `langfn/orchestration`
- `langfn/graph`
- `langfn/agents`
- `langfn/observability`
- `langfn/http`
- `langfn/structured`
- `langfn/rag`
- `langfn/memory`
- `langfn/evaluation`
- `langfn/mcp`
- `langfn/utils`

Python:

- `langfn`
- `langfn.models`
- `langfn.prompts`
- `langfn.tools`
- `langfn.orchestration`
- `langfn.graph`
- `langfn.agents`
- `langfn.observability`
- `langfn.http`
- `langfn.structured`
- `langfn.rag`
- `langfn.memory`
- `langfn.evaluation`
- `langfn.mcp`

## Core runtime contract

Both SDKs ship aligned workflow primitives with language-appropriate naming:

- client construction with `LangFn` plus provider helpers
- `complete`, `chat`, streaming, batch completion, embeddings, feedback, and trace retrieval
- prompt templates and prompt registries
- orchestration chains, state graphs, and agents
- RAG retrievers, vector stores, and memory
- observability, HTTP routes, and MCP client/server helpers
- evaluation datasets, metrics, and compare flows

## First-party providers

- `openai`
- `anthropic`
- `ollama`
- `google`
- `mistral`
- `custom`
- `mock`

Detailed feature coverage lives in [COMPATIBILITY.md](./COMPATIBILITY.md).

## Production boundaries

- DB-vector-store reference search is explicitly non-production unless delegated indexed search is configured.
- Built-in tools enforce outbound-policy and secret-provider hooks by default.
- Provider transports use pooled or reused per-language transport helpers.
- Release readiness is declared only after the repo-root gate passes.

## Release gate

Run the final verification from the repository root:

```bash
npm run gate:langfn-release
```

The gate validates:

- TypeScript build and full TypeScript test suite
- full Python test suite
- package import smoke checks in both languages
- HTTP, MCP, and observability smoke checks
- LangFn duplication threshold and shared-superfunctions reuse checks
