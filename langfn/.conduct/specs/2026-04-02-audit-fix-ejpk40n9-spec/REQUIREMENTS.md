# Requirement IDs

- PKG-001
- PKG-002
- API-001
- MODEL-001
- MODEL-002
- PROMPT-001
- PROMPT-002
- STRUCT-001
- TOOL-001
- TOOL-002
- ORCH-001
- GRAPH-001
- AGENT-001
- AGENT-002
- MEM-001
- RAG-001
- STREAM-001
- OBS-001
- OBS-002
- HTTP-001
- HTTP-002
- MCP-001
- EVAL-001
- PERF-001
- SEC-001
- QUAL-001
- ENG-001

## PKG-001

- ID: PKG-001
- Priority: P0
- Statement: LangFn MUST publish the canonical package identity `langfn` in TypeScript and Python and MUST expose the documented subpath/module surfaces used by its examples and tests.
- Rationale: Packaging drift is a release blocker because it makes the documented product non-consumable.
- Acceptance criteria:
  - TypeScript `package.json` `name` is `langfn`.
  - TypeScript export map includes `langfn/models`, `langfn/prompts`, `langfn/tools`, `langfn/orchestration`, `langfn/graph`, `langfn/agents`, `langfn/observability`, `langfn/http`, `langfn/structured`, `langfn/rag`, `langfn/memory`, `langfn/evaluation`, and `langfn/mcp`.
  - Python public imports in the spec’s Public API section succeed.
  - All README examples use valid import paths.
- Test vectors: TV-PKG-001
- Notes: A differently scoped TypeScript package name is not allowed.

## PKG-002

- ID: PKG-002
- Priority: P0
- Statement: LangFn MUST keep its version, build metadata, health metadata, and repo-root build/test commands synchronized across TypeScript and Python artifacts.
- Rationale: Version drift and missing build/test configs invalidate release confidence.
- Acceptance criteria:
  - TypeScript manifest version, Python manifest version, Python `__version__`, and HTTP health version all match exactly.
  - TypeScript ships `tsup.config.ts` and `vitest.config.ts`.
  - Repo-root verification commands for TypeScript and Python build/test are documented and pass.
  - The root and language-specific READMEs reference the same released version and install story.
- Test vectors: TV-PKG-002
- Notes: This requirement covers release metadata consistency only; runtime behavior is covered elsewhere.

## API-001

- ID: API-001
- Priority: P0
- Statement: LangFn MUST expose parity-defined TypeScript and Python client APIs for `withModel`, `complete`, `chat`, `stream`, `streamSSE`/`stream_sse`, `completeBatch`, `embed`, `feedback`, `getTraces`, prompt registries, RAG chains, and agent constructors, returning canonical response objects with trace IDs and optional cost/parsed fields.
- Rationale: Cross-language API drift currently breaks examples, tests, and developer expectations.
- Acceptance criteria:
  - Both languages expose the methods named in the statement.
  - Completion and chat responses include `traceId`/`trace_id` and MAY include `cost` and `parsed`.
  - Batch results preserve input order.
  - Missing required inputs fail with `VALIDATION_ERROR`.
- Test vectors: TV-API-001
- Notes: Method naming MUST follow language conventions, but method capability MUST remain aligned.

## MODEL-001

- ID: MODEL-001
- Priority: P0
- Statement: LangFn MUST provide first-party provider adapters for OpenAI, Anthropic, Ollama, Google, and Mistral plus a custom adapter SPI, and each first-party adapter MUST support completion, chat, and streaming semantics through the canonical model interface.
- Rationale: The existing spec and examples promise a model-agnostic SDK, not a partial provider subset.
- Acceptance criteria:
  - `openai`, `anthropic`, `ollama`, `google`, `mistral`, and `custom` providers are constructible through the public API.
  - OpenAI and at least one other provider support tool-calling payload mapping.
  - OpenAI embeddings are first-party; other providers MAY implement embeddings through the custom SPI.
  - Unsupported provider names fail with `UNSUPPORTED_PROVIDER`.
- Test vectors: TV-MODEL-001
- Notes: A provider SPI does not replace required first-party adapters.

## MODEL-002

- ID: MODEL-002
- Priority: P0
- Statement: Provider invocation MUST use normalized errors, bounded retries, timeout and cancellation controls, and pooled or reused transports, and batch execution MUST preserve request order while surfacing partial failures explicitly.
- Rationale: Production-readiness requires operationally safe provider behavior rather than raw network exceptions.
- Acceptance criteria:
  - Provider auth failures normalize to `PROVIDER_AUTH`.
  - Provider rate-limit failures normalize to `PROVIDER_RATE_LIMIT` and expose retry timing when available.
  - Timeout and cancellation failures normalize to `PROVIDER_TIMEOUT` or an explicit abort error.
  - Batch APIs return results aligned to the input index and preserve successful results when partial failure mode is enabled.
- Test vectors: TV-MODEL-002
- Notes: Transport reuse MAY be implemented via shared clients, pools, or adapter-managed transports.

## PROMPT-001

- ID: PROMPT-001
- Priority: P0
- Statement: LangFn MUST export `PromptTemplate`, `ChatTemplate`, and `FewShotPrompt` in both languages and MUST render them deterministically while rejecting missing required variables.
- Rationale: Prompt management is part of the original LangFn intent and is already referenced by tests and docs.
- Acceptance criteria:
  - `PromptTemplate` renders scalar substitutions deterministically.
  - `ChatTemplate` returns ordered message objects with role/content pairs.
  - `FewShotPrompt` preserves example order and separator configuration.
  - Missing required variables fail with `VALIDATION_ERROR` or `SchemaValidationError`.
- Test vectors: TV-PROMPT-001
- Notes: Placeholder syntax MUST be documented and shared across examples.

## PROMPT-002

- ID: PROMPT-002
- Priority: P1
- Statement: Prompt registries MUST persist prompts through shared DB abstractions and MUST support exact semantic-version lookup, deterministic `latest` resolution, metadata, and public export parity in both languages.
- Rationale: Prompt persistence is core LangSmith/LangFuse-like functionality promised by the langfn design docs.
- Acceptance criteria:
  - Save and load use shared DB adapter contracts rather than bespoke storage contracts.
  - Versioned lookups are exact.
  - `latest` resolution is deterministic.
  - Registry save/load/list APIs are exported in both languages.
- Test vectors: TV-PROMPT-002
- Notes: `latest` MUST NOT rely on storage return order.

## STRUCT-001

- ID: STRUCT-001
- Priority: P0
- Statement: Structured output parsing MUST support complete and chat responses in both languages, MUST validate against Zod/Pydantic schemas, and MUST emit canonical schema errors when the model output is missing JSON or fails validation.
- Rationale: Structured outputs are part of the refinement spec and a major production-readiness gap in the TypeScript implementation.
- Acceptance criteria:
  - A valid JSON object in model output is parsed into the requested typed schema.
  - Invalid JSON fails with `VALIDATION_ERROR` or `SCHEMA_VALIDATION`.
  - Schema mismatches include field-level error details.
  - Structured output parsing does not mutate the raw provider payload.
- Test vectors: TV-STRUCT-001
- Notes: The parser MAY extract JSON from surrounding prose, but extraction rules MUST be documented.

## TOOL-001

- ID: TOOL-001
- Priority: P0
- Statement: Tool definitions MUST compile to provider-native function/tool payloads and LangFn agents MUST round-trip assistant tool calls and tool results without losing tool IDs, argument fidelity, or tool result ordering.
- Rationale: The audit found the TypeScript tool-calling path broken at the client/provider boundary.
- Acceptance criteria:
  - Provider-neutral tool schemas serialize correctly for at least OpenAI and Anthropic.
  - Tool call arguments are validated before execution.
  - Tool result messages preserve `toolCallId` and execution order.
  - Unknown tools fail with `TOOL_EXECUTION_ERROR` or `TOOL_SCHEMA_ERROR`.
- Test vectors: TV-TOOL-001
- Notes: Provider mapping MUST occur before the provider network request is issued.

## TOOL-002

- ID: TOOL-002
- Priority: P0
- Statement: Built-in tools MUST be safe by default: `calculator` MUST use a parser rather than `eval`, `api_call` MUST enforce outbound policy, `web_search` MUST require an explicit search backend, and `code_exec` MUST only run through an explicit sandbox executor or fail with `TOOL_DISABLED`.
- Rationale: Built-in tool safety is a direct production-readiness requirement and audit blocker.
- Acceptance criteria:
  - `calculator` rejects expressions outside the allowed grammar without using `eval`.
  - `api_call` blocks loopback, RFC1918, link-local, and metadata-service targets unless explicitly allowed.
  - `web_search` fails with `NOT_CONFIGURED` when no backend is installed.
  - `code_exec` fails with `TOOL_DISABLED` unless a sandbox executor is configured.
- Test vectors: TV-TOOL-002
- Notes: Tool policy failures MUST be explicit and machine-readable.

## ORCH-001

- ID: ORCH-001
- Priority: P1
- Statement: LangFn orchestration MUST provide sequential, parallel, map-reduce, and router chain primitives in both languages with deterministic ordering and bounded concurrency.
- Rationale: Orchestration is a core LangChain-like promise in the original intent and main spec.
- Acceptance criteria:
  - Sequential chains pipe outputs into the next step in order.
  - Parallel chains preserve the declared step order in the result list.
  - Map-reduce chains preserve mapped item order before reduction.
  - Router chains fail with `VALIDATION_ERROR` or `INTERNAL_ERROR` for unknown route keys.
- Test vectors: TV-ORCH-001
- Notes: Router functions MAY use model calls but MUST still return deterministic route keys for deterministic tests.

## GRAPH-001

- ID: GRAPH-001
- Priority: P1
- Statement: State graph execution MUST support named nodes, static edges, conditional edges, checkpoint persistence, max-step enforcement, and interrupt/resume semantics in both languages.
- Rationale: LangGraph-style workflows are part of the original intended scope, and the current implementation is only a partial skeleton.
- Acceptance criteria:
  - Graphs can compile and invoke from an entry point.
  - Conditional routing to `__end__` or equivalent terminates successfully.
  - Max-step overflow fails with a canonical graph error.
  - Checkpoints can persist and resume graph state after an interrupt.
- Test vectors: TV-GRAPH-001
- Notes: Visualization/export is required by documentation and MAY be delivered as Mermaid/JSON rather than GUI output.

## AGENT-001

- ID: AGENT-001
- Priority: P1
- Statement: ToolAgent and ReActAgent MUST be implemented in both languages and MUST preserve full assistant/tool transcript state across each iteration.
- Rationale: Agents are a major user-facing capability and already partly present.
- Acceptance criteria:
  - ToolAgent succeeds on a deterministic tool-call loop.
  - ReActAgent records assistant/tool exchanges in order.
  - Agent iteration limits are enforced.
  - Unknown tool usage fails with a canonical tool error rather than raw exceptions.
- Test vectors: TV-AGENT-001
- Notes: Transcript preservation includes tool call IDs and tool results.

## AGENT-002

- ID: AGENT-002
- Priority: P1
- Statement: LangFn MUST implement PlanExecuteAgent and a bounded multi-agent coordinator surface in both languages, with explicit planner, executor, and coordinator semantics and deterministic failure behavior when a plan cannot be completed.
- Rationale: The existing langfn bundle promises more than a single-agent loop.
- Acceptance criteria:
  - A planner can produce an ordered plan and pass steps to an executor.
  - Multi-agent coordination can route work among named agents.
  - Planner or coordinator failures surface canonical errors.
  - Planning and execution limits are configurable and enforced.
- Test vectors: TV-AGENT-002
- Notes: The planner MAY be model-driven; deterministic tests MUST use mocks.

## MEM-001

- ID: MEM-001
- Priority: P1
- Statement: LangFn MUST provide BufferMemory and SummaryMemory in both languages with explicit caps, deterministic retention order, and summary replacement behavior.
- Rationale: Ephemeral conversational memory remains in LangFn even after the durable-memory boundary is resolved.
- Acceptance criteria:
  - Buffer memory retains the newest entries up to its configured cap.
  - Summary memory rolls older content into a summary when caps are exceeded.
  - Summary insertion order is deterministic.
  - Clearing memory resets both live and summarized state.
- Test vectors: TV-MEM-001
- Notes: Cap calculation MAY be message-count or token-count based, but MUST be explicit.

## RAG-001

- ID: RAG-001
- Priority: P1
- Statement: LangFn MUST expose retriever-centric RAG APIs, MUST ship clearly documented reference vector stores, and MUST integrate durable production retrieval through `memoryfn` or adapter-native indexed backends rather than bespoke langfn-only production persistence.
- Rationale: This requirement preserves the original RAG scope while resolving the later memoryfn boundary conflict.
- Acceptance criteria:
  - LangFn exports `Retriever`, `VectorStore`, and a RAG chain surface.
  - In-memory and reference DB stores are marked as non-production backends.
  - A `memoryfn`-backed retriever adapter path is documented and tested.
  - Production mode MUST NOT rely on application-side full-table reranking of durable stores.
- Test vectors: TV-RAG-001
- Notes: A reference DB store MAY remain available for examples and local tests.

## STREAM-001

- ID: STREAM-001
- Priority: P0
- Statement: LangFn streaming MUST normalize provider output into the canonical event taxonomy across async iterators, SSE, WebSocket-compatible outputs, and agent/tool streams.
- Rationale: The refinement spec requires a single streaming shape, and the audit found that current implementations only partially satisfy it.
- Acceptance criteria:
  - The emitted event types include `content`, `tool_call`, `tool_result`, `token_usage`, `trace_event`, `reasoning`, `end`, and `error`.
  - Every streamed event includes the invocation trace ID.
  - `end` and `error` are terminal events.
  - Cancellation and timeout terminate the stream with canonical error behavior.
- Test vectors: TV-STREAM-001
- Notes: WebSocket support MAY reuse the same event payloads without a separate schema.

## OBS-001

- ID: OBS-001
- Priority: P0
- Statement: Every LangFn invocation MUST create a fresh trace, MUST record canonical span names, and MUST persist/query traces and feedback through shared DB abstractions.
- Rationale: Trace correctness and retrieval were major blockers in the audit.
- Acceptance criteria:
  - A new trace ID is created for each invocation.
  - Trace storage persists invocation and span metadata through shared DB adapters.
  - `getTraces` returns actual stored results rather than placeholders.
  - Feedback links to an existing trace and is idempotent by stable client key.
- Test vectors: TV-OBS-001
- Notes: A `LangFn` instance MUST NOT reuse one trace ID for multiple invocations.

## OBS-002

- ID: OBS-002
- Priority: P1
- Statement: Observability MUST support watchfn export, cost metering, budget enforcement, redaction, and optional OTLP mirroring while guaranteeing that redaction occurs before persistence or export.
- Rationale: LangFn’s observability promise includes watchfn integration and cost awareness, and the refinement spec adds redaction and OTLP.
- Acceptance criteria:
  - Cost and budget controls attach to completion/chat results when configured.
  - Budget overflow fails with `BUDGET_EXCEEDED`.
  - Redacted fields do not appear in stored/exported payloads.
  - watchfn export is first-class and OTLP export mirrors the same redacted content when enabled.
- Test vectors: TV-OBS-002
- Notes: OTLP export is optional at runtime but MUST be fully supported when configured.

## HTTP-001

- ID: HTTP-001
- Priority: P0
- Statement: LangFn MUST expose framework-agnostic HTTP route sets for `health`, `complete`, `chat`, `stream`, `embed`, `traces`, and `feedback` in both languages using canonical envelopes and shared HTTP abstractions.
- Rationale: The SDK is explicitly designed to be framework-agnostic instead of bundling framework-specific routers.
- Acceptance criteria:
  - Both TypeScript and Python export route builders that use shared superfunctions HTTP contracts.
  - `POST /stream` emits canonical streaming event envelopes as SSE.
  - Success and error responses follow the canonical HTTP envelopes from `SPEC.md`.
  - `health` returns the released LangFn version string.
- Test vectors: TV-HTTP-001
- Notes: Framework-specific adapter installation remains the caller’s responsibility.

## HTTP-002

- ID: HTTP-002
- Priority: P0
- Statement: LangFn HTTP routes MUST support pluggable auth, tenant/user/run/conversation headers, request validation, and rate limiting keyed by tenant context.
- Rationale: Unauthenticated, unscoped routes were a direct audit failure and are incompatible with production use.
- Acceptance criteria:
  - `/health` MAY remain anonymous; all other routes MUST honor configured auth policy.
  - Canonical tenant headers are copied into trace metadata and rate-limit keys.
  - Invalid bodies fail with `VALIDATION_ERROR`.
  - Rate-limited requests fail with `RATE_LIMITED`.
- Test vectors: TV-HTTP-002
- Notes: The auth middleware MUST be wired through shared superfunctions auth abstractions.

## MCP-001

- ID: MCP-001
- Priority: P1
- Statement: LangFn MUST implement MCP client and server surfaces in both languages with stdio and SSE transports, deterministic tool discovery/call envelopes, canonical transport/protocol errors, and graceful shutdown behavior.
- Rationale: MCP is a first-class refinement requirement and already partially present in Python.
- Acceptance criteria:
  - MCP client can list tools and call tools over stdio.
  - MCP server can expose LangFn tools over stdio and SSE.
  - Transport failures normalize to `MCP_TRANSPORT_ERROR` or `MCP_PROTOCOL_ERROR`.
  - Shutdown closes underlying processes or sockets without hanging.
- Test vectors: TV-MCP-001
- Notes: OAuth/session management MAY be layered behind the SSE transport configuration.

## EVAL-001

- ID: EVAL-001
- Priority: P1
- Statement: LangFn evaluation MUST support datasets, exact-match and custom metrics, compare/experiment workflows, and testfn export/report hooks in both languages.
- Rationale: Evaluation is part of the langsmith/langfuse-like promise and is already represented in the spec bundle.
- Acceptance criteria:
  - Dataset item models are publicly exported.
  - Evaluators compute per-item and aggregate results.
  - Compare flows can evaluate multiple configured models.
  - A testfn adapter or export hook is available for report forwarding.
- Test vectors: TV-EVAL-001
- Notes: Deterministic tests MUST use mock models.

## PERF-001

- ID: PERF-001
- Priority: P0
- Statement: LangFn MUST use connection pooling or transport reuse, canonical cache keys, cachefn-compatible caching, scalable retrieval backends for production mode, and configurable concurrency/batch limits with preserved result ordering.
- Rationale: Performance and scalability were explicit mandatory audit criteria and direct audit failures.
- Acceptance criteria:
  - Provider client implementations reuse connections or pooled transports.
  - Cache keys are stable for equivalent logical inputs.
  - cachefn integration hooks exist and are documented.
  - Production retrieval mode uses indexed or delegated search rather than full-table in-process reranking.
- Test vectors: TV-PERF-001
- Notes: Reference backends MAY remain slower as long as they are explicitly labeled non-production.

## SEC-001

- ID: SEC-001
- Priority: P0
- Statement: LangFn MUST source secrets via `secfn` or runtime secret-provider hooks, MUST redact configured sensitive fields before storage/export, and MUST sanitize tool and HTTP output according to configured policies.
- Rationale: Security is a mandatory audit dimension and a direct audit blocker.
- Acceptance criteria:
  - Secret lookup hooks exist for provider credentials and HTTP auth secrets.
  - Redaction occurs before persistence/export.
  - Output sanitization policies can be applied to tool results and HTTP responses.
  - Security policy violations surface canonical error codes rather than raw stack traces.
- Test vectors: TV-SEC-001
- Notes: Unsafe debug logging is allowed only behind an explicit documented escape hatch.

## QUAL-001

- ID: QUAL-001
- Priority: P0
- Statement: LangFn MUST ship runnable docs/examples plus release-gate verification that covers package imports, provider compatibility, HTTP routes, MCP transports, observability, and cross-language API parity from repo root.
- Rationale: A production-ready SDK needs executable evidence, not only implementation code.
- Acceptance criteria:
  - Root and language-specific READMEs exist and are runnable.
  - Repo-root commands for TS build/test and Python test pass.
  - Provider compatibility tests exist for all first-party providers.
  - Release-gate commands validate package import surfaces and canonical HTTP/MCP smoke tests.
- Test vectors: TV-QUAL-001
- Notes: Verification commands MUST be runnable from repo root with no absolute paths.

## ENG-001

- ID: ENG-001
- Priority: P1
- Statement: LangFn MUST consolidate duplicate provider, vector-store, and agent control logic into shared language-local utilities and MUST prefer shared superfunctions packages over bespoke implementations when shared abstractions already exist.
- Rationale: Reducing internal duplication and reusing ecosystem primitives improves maintainability and conformance to `AGENTS.md`.
- Acceptance criteria:
  - Shared provider transport/error helpers exist per language.
  - Shared vector similarity or retrieval helpers exist per language rather than duplicated per backend.
  - Auth, HTTP, DB, secrets, and testing infrastructure use superfunctions/shared packages where available.
  - A duplication gate or report exists in the release process and remains below an agreed threshold.
- Test vectors: TV-ENG-001
- Notes: This requirement is about maintainable implementation structure, not user-facing API shape.
