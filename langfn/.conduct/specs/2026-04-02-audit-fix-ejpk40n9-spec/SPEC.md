# Metadata

- timestamp: 2026-04-02T14:30:10.768836Z
- agent_name: spec
- model: gpt-5-codex
- launcher: Codex Desktop
- workspace/project path: repo root
- os: Darwin arm64
- shell: zsh
- repo metadata: git detached HEAD at `7adae77`; dirty status: dirty
- spec_folder: `2026-04-02-audit-fix-ejpk40n9-spec`
- spec_folder path: `langfn/.conduct/specs/2026-04-02-audit-fix-ejpk40n9-spec`
- spec_type: `audit-fix`
- spec_id: `ejpk40n9`
- input paths:
  - `AGENTS.md`
  - `langfn/v0.intent.md`
  - `langfn/SPEC.md`
  - `langfn/.conduct/IMPLEMENTATION_SPEC.md`
  - `langfn/.conduct/improvements.spec.md`
  - `langfn/.conduct/audits/2026-04-02-pqjcdrvg-full-audit.md`
- audit reference:
  - audit path: `langfn/.conduct/audits/2026-04-02-pqjcdrvg-full-audit.md`
  - audited scope: `langfn/`

# Overview

## Project name

LangFn Production Readiness Remediation

## One-sentence goal

LangFn MUST become a production-ready, dual-language, self-hosted AI workflow SDK that preserves the original comprehensive scope while fixing the packaging, API, observability, security, scalability, and shared-infrastructure gaps identified in the 2026-04-02 full audit.

## Context

- Target users:
  - superfunctions maintainers
  - application developers building self-hosted LLM workflows on Node.js or Python
- Target environments:
  - TypeScript SDK: Node.js 18+ ESM, server-side, online
  - Python SDK: Python 3.10+, server-side, online
  - HTTP adapters: framework-agnostic router contracts consumed through superfunctions adapters
  - streaming: async iterators, SSE, WebSocket-compatible event model
- Languages/packages required:
  - TypeScript
  - Python
  - `@superfunctions/db`, `@superfunctions/http`, `@superfunctions/auth`
  - `superfunctions.db`, `superfunctions.http`
  - `watchfn`
  - `memoryfn`
  - `secfn`
  - `cachefn`
  - `testfn`
- Existing systems it must integrate with:
  - superfunctions HTTP adapters
  - shared DB adapters
  - watchfn tracing/monitoring
  - memoryfn durable retrieval/memory backends
  - secfn secret and redaction facilities
  - testfn evaluation/reporting
- Data model summary:
  - prompt records with semantic version, tags, timestamps, body, checksum
  - trace records with run metadata, spans, timing, model/provider info, usage, cost, redacted payloads, tenant/user context
  - feedback records linked to trace IDs
  - cache records keyed by canonical request hash
  - RAG document metadata and retriever configuration records when a DB-backed reference store is used
- Security model:
  - HTTP routes MUST support pluggable authn/authz
  - multi-tenant context MUST be represented by canonical headers and trace metadata
  - secrets MUST NOT be hardcoded or persisted in trace payloads
  - PII MUST be redactable before persistence/export
- Performance constraints:
  - SDK overhead for non-network work MUST remain bounded and measurable
  - trace creation MUST be O(1) per invocation
  - batch APIs MUST preserve input order
  - durable retrieval MUST NOT rely on full-table application-side reranking in production mode
- Non-goals:
  - hosted SaaS control plane
  - browser-only offline persistence
  - GUI workflow editor
  - provider fine-tuning job orchestration
- Hard constraints:
  - no nested monorepo structure
  - artifacts MUST use repository-relative paths only
  - TypeScript and Python public APIs MUST be intentionally aligned, not accidentally divergent
  - shared superfunctions packages MUST be reused when the abstraction already exists

## Resolution of prior spec conflict

The prior langfn bundle contained a scope conflict about durable memory ownership.

This remediation spec resolves the conflict as follows:

1. LangFn MUST continue to present first-class retrieval and memory capabilities to end users.
2. LangFn MUST own ephemeral memory primitives and retriever-facing orchestration APIs.
3. Durable production-grade vector stores, long-term memory persistence, and profile/entity storage MUST integrate through `memoryfn` or adapter-backed retriever interfaces rather than bespoke langfn-only persistence ownership.
4. LangFn MAY retain in-memory and reference DB-backed stores for tests, examples, and local development, but those reference stores MUST be documented as non-production backends.

# Glossary

- Invocation: one logical end-user request executed through `complete`, `chat`, `stream`, `completeBatch`, or an agent run.
- Trace: the top-level record for one invocation; it has exactly one trace ID and zero or more spans.
- Span: a timed child event inside a trace, such as prompt rendering, provider call, tool execution, or retrieval.
- Tool spec: the provider-neutral schema for a callable tool.
- Structured output: validated JSON-shaped output parsed against Zod or Pydantic schemas.
- Retriever: a provider-neutral interface that returns ranked context documents for a query.
- Reference backend: a simple implementation shipped for tests/examples/local usage and not the recommended production path.
- Durable backend: a production-capable storage/retrieval implementation backed by `memoryfn` or an adapter-native indexed store.
- Tenant context: normalized request scoping data including tenant ID, user ID, run ID, agent ID, and conversation ID.
- Canonical envelope: the exact request or response shape defined by this spec for library or HTTP I/O.
- Redaction policy: the rule set that determines which fields are masked, hashed, or omitted before logging/export.

# Goals / Non-goals

## Goals

1. LangFn MUST satisfy the original intent of being a comprehensive AI development SDK for LLM workflows.
2. LangFn MUST publish coherent TypeScript and Python SDKs with aligned public APIs and examples.
3. LangFn MUST provide production-safe model invocation, tool calling, orchestration, agents, observability, streaming, evaluation, and retriever integration.
4. LangFn MUST integrate with the superfunctions ecosystem instead of duplicating cross-cutting infrastructure.
5. LangFn MUST pass verifiable packaging, API, and runtime release gates from repo root.

## Non-goals

1. This spec does NOT define a hosted LangFn service.
2. This spec does NOT require a browser-native offline SDK.
3. This spec does NOT require a visual no-code editor.
4. This spec does NOT require provider fine-tuning APIs.

# Public API

## TypeScript surface

```ts
export type ProviderName =
  | "openai"
  | "anthropic"
  | "ollama"
  | "google"
  | "mistral"
  | "custom";

export interface LangFnConfig {
  model: ProviderModelConfig | ChatModel;
  observability?: ObservabilityConfig;
  cache?: CacheConfig;
  security?: SecurityConfig;
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  retriever?: Retriever | null;
}

export interface LangFn {
  withModel(model: ProviderModelConfig | ChatModel): LangFn;
  complete<TSchema extends z.ZodTypeAny = z.ZodNever>(
    prompt: string,
    options?: CompleteOptions<TSchema>
  ): Promise<CompletionResult<TSchema>>;
  chat<TSchema extends z.ZodTypeAny = z.ZodNever>(
    messages: Message[],
    options?: ChatOptions<TSchema>
  ): Promise<ChatResult<TSchema>>;
  stream(
    input: string | Message[],
    options?: StreamOptions
  ): AsyncIterable<StreamEvent>;
  streamSSE(
    input: string | Message[],
    options?: StreamOptions
  ): AsyncIterable<string>;
  completeBatch(
    requests: BatchRequest[],
    options?: BatchOptions
  ): Promise<BatchResult[]>;
  embed(texts: string | string[]): Promise<number[] | number[][]>;
  feedback(request: FeedbackRequest): Promise<void>;
  getTraces(query?: TraceQuery): Promise<TraceRecord[]>;
  createToolAgent(config: ToolAgentConfig): ToolAgent;
  createReactAgent(config: ReActAgentConfig): ReActAgent;
  createPlanExecuteAgent(config: PlanExecuteAgentConfig): PlanExecuteAgent;
  createPromptRegistry(config: PromptRegistryConfig): PromptRegistry;
  createRAGChain(config: RetrieverChainConfig): RetrieverChain;
}

export function langfn(config: LangFnConfig): LangFn;
```

Required subpath exports:

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
- `langfn/mcp`
- `langfn/memory`
- `langfn/evaluation`
- `langfn/utils`

## Python surface

```py
class LangFn:
    def __init__(
        self,
        *,
        model: ProviderModelConfig | ChatModel,
        observability: ObservabilityConfig | dict | None = None,
        cache: CacheConfig | dict | None = None,
        security: SecurityConfig | dict | None = None,
        retry: RetryConfig | None = None,
        rate_limit: RateLimitConfig | None = None,
        retriever: Retriever | None = None,
    ) -> None: ...

    def with_model(self, model: ProviderModelConfig | ChatModel) -> "LangFn": ...
    async def complete(self, prompt: str, **options) -> CompletionResponse: ...
    async def chat(self, messages: list[dict], **options) -> ChatResponse: ...
    async def stream(self, input: str | list[dict], **options) -> AsyncIterator[StreamEvent]: ...
    async def stream_sse(self, input: str | list[dict], **options) -> AsyncIterator[str]: ...
    async def complete_batch(self, requests: list[BatchRequest], **options) -> list[BatchResult]: ...
    async def embed(self, texts: str | list[str]) -> list[float] | list[list[float]]: ...
    async def feedback(self, request: FeedbackRequest) -> None: ...
    async def get_traces(self, query: TraceQuery | None = None) -> list[TraceRecord]: ...
    def create_tool_agent(self, config: ToolAgentConfig) -> ToolAgent: ...
    def create_react_agent(self, config: ReActAgentConfig) -> ReActAgent: ...
    def create_plan_execute_agent(self, config: PlanExecuteAgentConfig) -> PlanExecuteAgent: ...
    def create_prompt_registry(self, config: PromptRegistryConfig) -> PromptRegistry: ...
    def create_rag_chain(self, config: RetrieverChainConfig) -> RetrieverChain: ...
```

Required Python public imports:

- `from langfn import LangFn`
- `from langfn.prompts import PromptTemplate, ChatTemplate, FewShotPrompt, PromptRegistry`
- `from langfn.observability import Tracer, TraceStorage, CostMeter, Budgets`
- `from langfn.evaluation import DatasetItem, Evaluator, EvaluationResult`
- `from langfn.agents import ToolAgent, ReActAgent, PlanExecuteAgent`
- `from langfn.mcp import MCPClient, MCPServer`

## Canonical library result shapes

```json
{
  "content": "string",
  "usage": {
    "promptTokens": 12,
    "completionTokens": 34,
    "totalTokens": 46
  },
  "cost": {
    "input": 0.0012,
    "output": 0.0024,
    "total": 0.0036,
    "currency": "USD"
  },
  "traceId": "trc_01hx...",
  "parsed": null,
  "raw": {}
}
```

```json
{
  "message": {
    "role": "assistant",
    "content": "string",
    "toolCalls": [
      {
        "id": "call_1",
        "name": "lookup_weather",
        "arguments": {
          "city": "Paris"
        }
      }
    ]
  },
  "usage": {
    "promptTokens": 8,
    "completionTokens": 18,
    "totalTokens": 26
  },
  "cost": {
    "input": 0.0008,
    "output": 0.0018,
    "total": 0.0026,
    "currency": "USD"
  },
  "traceId": "trc_01hx...",
  "parsed": null,
  "raw": {}
}
```

## Canonical HTTP endpoints

- `GET /health`
- `POST /complete`
- `POST /chat`
- `POST /stream`
- `POST /embed`
- `GET /traces`
- `POST /feedback`

Framework integration MUST occur through:

- TypeScript: `@superfunctions/http` plus adapter packages
- Python: `superfunctions.http` plus adapter packages

# Data formats / protocol

## HTTP success envelope

```json
{
  "ok": true,
  "traceId": "trc_01hx...",
  "data": {},
  "error": null
}
```

## HTTP error envelope

```json
{
  "ok": false,
  "traceId": "trc_01hx..." ,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "messages[0].role is required",
    "retryable": false,
    "details": {
      "field": "messages[0].role"
    }
  }
}
```

## Streaming event envelope

```json
{
  "type": "content",
  "traceId": "trc_01hx...",
  "content": "Hello",
  "delta": "Hel"
}
```

Allowed event `type` values:

- `content`
- `tool_call`
- `tool_result`
- `token_usage`
- `trace_event`
- `reasoning`
- `end`
- `error`

Event ordering rules:

1. `content`, `tool_call`, `tool_result`, `token_usage`, and `trace_event` MAY interleave.
2. `end` MUST appear at most once and MUST terminate the stream.
3. `error` MUST terminate the stream and MUST be the final event.
4. Every event in one invocation MUST carry the same `traceId`.

## Canonical tenant headers

- `x-tenant-id`
- `x-user-id`
- `x-agent-id`
- `x-run-id`
- `x-conversation-id`

These headers MUST be optional at the transport layer and MUST become required when the configured auth policy requires tenant scoping.

## Error codes

- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `UNSUPPORTED_PROVIDER`
- `PROVIDER_AUTH`
- `PROVIDER_RATE_LIMIT`
- `PROVIDER_TIMEOUT`
- `CONTEXT_LENGTH`
- `TOOL_SCHEMA_ERROR`
- `TOOL_EXECUTION_ERROR`
- `TOOL_DISABLED`
- `TOOL_POLICY_VIOLATION`
- `NOT_CONFIGURED`
- `BUDGET_EXCEEDED`
- `TRACE_NOT_FOUND`
- `MCP_TRANSPORT_ERROR`
- `MCP_PROTOCOL_ERROR`
- `INTERNAL_ERROR`

# Semantics

1. Package identity
   - TypeScript MUST publish `langfn`, not a differently scoped name.
   - Python MUST publish `langfn`.
2. Prompt registry
   - explicit versions MUST be exact-match lookups
   - `latest` MUST resolve deterministically by highest valid semantic version; ties MUST resolve by newest `updatedAt`
3. Tool calling
   - provider-neutral tool specs MUST be transformed into provider-native formats
   - assistant tool calls MUST be replayable in message history without lossy conversion
4. Caching
   - cache keys MUST hash a canonical JSON form with sorted keys
   - identical logical requests MUST map to identical keys
5. Complete batch
   - result order MUST match input order
   - partial failures MUST preserve successes and surface failures positionally
6. Trace IDs
   - each invocation MUST create a new trace ID
   - a `LangFn` instance MUST NOT reuse one trace ID across multiple invocations
7. Durable retrieval boundary
   - LangFn MUST expose retriever-facing APIs
   - durable production stores MUST integrate via `memoryfn` or adapter-native indexed backends
   - reference stores MAY remain available for tests/examples
8. Built-in tools
   - `calculator`, `api_call`, `web_search`, and `code_exec` MUST be exported as factories
   - `api_call`, `web_search`, and `code_exec` MUST require explicit security policy or executor configuration before invocation
9. Versioning
   - TypeScript and Python package versions MUST match on any release tag

# Invariants

1. Determinism
   - prompt rendering, registry version resolution, cache key generation, batch result order, and trace ID assignment MUST be deterministic for a fixed input/configuration
   - provider text generation content is explicitly allowed to vary unless the provider/configuration guarantees determinism
2. Idempotency
   - `feedback` with the same `(traceId, source, submittedAt)` tuple MUST be idempotent
   - trace queries MUST be read-only
3. Ordering
   - `completeBatch` output order MUST equal input order
   - stream events MUST preserve provider order after LangFn normalization
4. Conflict rules
   - explicit request options override instance defaults
   - tenant-scoped route middleware overrides route-local anonymous mode
5. Consistency
   - docs, exported symbols, health versions, and manifests MUST agree on the released version

# Security

1. HTTP routes except `/health` MUST support auth middleware wiring.
2. Route handlers MUST validate all request bodies and query parameters before execution.
3. `api_call` MUST enforce outbound policy:
   - deny loopback, link-local, RFC1918, and metadata-service destinations by default
   - require explicit allowlists for arbitrary outbound hosts
4. `calculator` MUST NOT use `eval`.
5. `code_exec` MUST only run through an explicit sandbox executor; without one it MUST return `TOOL_DISABLED`.
6. Secrets MUST be loaded through `secfn` or runtime secret provider hooks; raw secret values MUST NOT be emitted in traces or error messages.
7. Redaction MUST apply before persistence and before watchfn/OTLP export.
8. PII logging MUST default to off.
9. Tenant headers, when present, MUST be copied into trace metadata and rate-limit keys.

# Limits / caps

- maximum prompt payload: 256 KiB UTF-8
- maximum chat messages per request: 256
- maximum tools per request: 64
- maximum batch size: 128 requests
- default max agent iterations:
  - ToolAgent: 8
  - ReActAgent: 12
  - PlanExecuteAgent: 24
- default graph max steps: 256
- maximum prompt registry template size: 64 KiB
- maximum prompt tags per prompt: 32
- maximum feedback comment size: 4 KiB
- default trace query limit: 50
- maximum trace query limit: 500
- SSE heartbeat interval: 15 seconds
- reference DB vector store candidate scan cap: 100
  - This cap MUST be documented as non-production

# Observability

Canonical span names:

- `langfn.prompt.build`
- `langfn.prompt.template`
- `langfn.provider.call`
- `langfn.provider.stream`
- `langfn.tool.execute`
- `langfn.tool.validate`
- `langfn.chain.execute`
- `langfn.graph.execute`
- `langfn.memory.retrieve`
- `langfn.memory.summarize`
- `langfn.eval.run`
- `langfn.eval.metric`

Required observability behaviors:

1. Every invocation MUST create one root trace and zero or more spans.
2. Costs and usage MUST be attached when price metadata is configured and provider usage is available.
3. Redaction MUST run before persistence/export.
4. Export to watchfn MUST be first-class.
5. OTLP mirroring MAY be enabled, but when configured it MUST mirror the same redacted payloads.
6. The following MUST NOT be logged unless an explicit unsafe debug mode is enabled:
   - raw API keys
   - authorization headers
   - redacted PII fields
   - code execution sandbox secrets

# Compatibility / versioning strategy

1. LangFn MUST use semantic versioning.
2. TypeScript and Python releases MUST share the same version string for one coordinated LangFn release.
3. Breaking public API changes MUST only occur in a major release.
4. Deprecated APIs MUST remain supported for at least one minor release and MUST emit a documented deprecation path.
5. TypeScript runtime target MUST remain Node.js 18+.
6. Python runtime target MUST remain 3.10+.

# Undefined / Explicitly user-deferred only

The following are Undefined and therefore NOT required by this spec:

1. a hosted LangFn cloud control plane
2. browser-native offline persistence
3. visual workflow editing UI
4. provider fine-tuning job APIs
5. any unsafe arbitrary code execution path outside a configured sandbox executor
