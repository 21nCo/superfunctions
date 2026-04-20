# Metadata

- timestamp: 2026-04-02T14:05:01.507343Z
- agent_name: audit
- model: gpt-5-codex
- launcher: Codex Desktop
- workspace/project path: repo root
- os: Darwin arm64
- shell: zsh
- repo metadata: git detached HEAD at `7adae77`; dirty status: clean
- intent/notes paths audited:
  - `AGENTS.md`
  - `langfn/v0.intent.md`
  - conversation task request in this audit thread, including mandatory audit criteria for performance, scalability, security, code duplication, shared superfunctions usage, packaging, and abstraction
- spec bundle paths audited:
  - `langfn/SPEC.md`
  - `langfn/.conduct/IMPLEMENTATION_SPEC.md`
  - `langfn/.conduct/improvements.spec.md`
- codebase scope audited:
  - `langfn/`
  - `package.json`
  - `turbo.json`
  - `packages/python-core/` (interface/reference checks only)
  - excluded for compliance judgment: existing historical files under `.conduct/audits/`
- commands executed during audit:
  - `rg --files | rg '(^|/)langfn(/|$)'`
  - `rg -n ... langfn/...`
  - `find langfn ...`
  - `sed -n ...`
  - `git status --short --branch`
  - `git rev-parse --short HEAD`
  - `uname -sm`
  - `npm test` (from `langfn/typescript/`)
  - `npm run build` (from `langfn/typescript/`)
  - `python3 -m pytest` (from `langfn/python/`)
  - `python3 -m pytest tests/test_prompt_and_structured.py tests/test_chain.py tests/test_tool_agent.py tests/test_openai_provider.py -q`
  - `python3 -m pytest tests/test_basics.py`
  - `npx jscpd langfn --min-lines 10 --min-tokens 50 --reporters console`
  - a one-off Python MCP smoke script that exercised `MCPClient.list_tools`, `MCPClient.call_tool`, and `StdioMCPTransport.close`

# Audit Scope

This is a full production-readiness audit of `langfn` against:

1. authoritative intent from `langfn/v0.intent.md`, `AGENTS.md`, and the current user request
2. the provided langfn spec bundle documents:
   - `langfn/SPEC.md`
   - `langfn/.conduct/IMPLEMENTATION_SPEC.md`
   - `langfn/.conduct/improvements.spec.md`

Important audit note: `langfn` does not provide a formal `REQUIREMENTS.md`, `TEST_VECTORS.md`, or `PLAN.md` bundle of the kind described by the audit skill. To preserve traceability, this audit derives explicit requirement IDs from the provided spec documents:

- `Axx` = derived requirements from `langfn/SPEC.md`
- `Bxx` = derived requirements from `langfn/.conduct/IMPLEMENTATION_SPEC.md`
- `Cxx` = derived requirements from `langfn/.conduct/improvements.spec.md`

Where the provided bundles disagree, this audit marks the item `SPEC CONFLICT` rather than silently choosing one.

Verification limitations:

- The TypeScript package could not be executed end-to-end in this workspace because local tool binaries were unavailable (`vitest` and `tsup` were not installed in the current environment).
- The Python full suite did execute, but it stopped at collection because of import/export regressions in public modules.
- The standalone MCP smoke test passed, but `pytest tests/test_mcp_stdio.py -q` did not complete within the observed window, so MCP pytest integration remains operationally suspect.

# Inputs Audited (Intent + Spec Bundles)

## Intent / Notes

1. `langfn/v0.intent.md`
   - create `langfn` as a comprehensive AI development SDK for LLM workflow needs
   - follow repo conventions from `AGENTS.md` and other superfunctions
   - provide both TypeScript and Python SDKs
   - combine features comparable to langchain + langgraph + langsmith + langfuse
   - include orchestration, workflows, model abstraction, tools, observability with watchfn integration, prompt management, and more
2. `AGENTS.md`
   - simple package naming for core functions
   - dual-language consistency expectations
   - artifacts in `.conduct/`
   - reuse shared packages instead of duplicating framework/database abstractions
3. Conversation request
   - production readiness audit
   - mandatory coverage: performance, scalability, security, code duplication status, shared superfunctions code usage, packaging, and abstraction

## Spec Bundles

1. `langfn/SPEC.md`
   - canonical product specification for architecture, features, database schema, deployment, and verification
2. `langfn/.conduct/IMPLEMENTATION_SPEC.md`
   - implementation-oriented interpretation of the main spec
3. `langfn/.conduct/improvements.spec.md`
   - refinement proposal adding MCP, structured outputs, cancellation, hardening, security, memoryfn boundary changes, and packaging/doc improvements

# High-Level Findings

## Verdict

`langfn` is not production ready.

The codebase shows promising groundwork, especially on the Python side, but it currently fails core production-readiness gates across packaging, public API stability, observability correctness, security hardening, and scalability. The repository also contains an unresolved spec conflict around long-term memory scope versus `memoryfn`, which materially affects what “done” means.

## Top Findings

1. The TypeScript package is not consumable as documented or specified.
   - `langfn/typescript/package.json` publishes `@langfn/core`, not `langfn`, and exports only `"."`, so documented subpath imports like `langfn/prompts`, `langfn/http`, `langfn/agents`, and `langfn/graph` cannot work as specified.
   - Evidence: `langfn/typescript/package.json:2-14`, `langfn/typescript/README.md:17-27`, `langfn/SPEC.md:309`, `langfn/SPEC.md:848`
2. The Python public API is internally inconsistent and breaks test collection before runtime behavior can be verified.
   - `langfn.observability` does not export `Budgets` or `CostMeter`; `langfn.evaluation` does not export `DatasetItem`; `langfn.prompts` imports `ChatPromptTemplate` from a file that only defines `PromptTemplate`.
   - Evidence: `langfn/python/langfn/observability/__init__.py:1-4`, `langfn/python/langfn/evaluation/__init__.py:1-3`, `langfn/python/langfn/prompts/__init__.py:1-5`, `langfn/python/langfn/prompts/template.py:7-17`
3. The TypeScript tool-calling path is broken in a way that prevents reliable agent/tool execution.
   - `LangFn.chat()` first serializes tools to JSON schema and then immediately overwrites that field with the original `Tool` objects via spread order.
   - Even if the overwrite bug were fixed, the OpenAI provider forwards `request.tools` directly rather than transforming them to the required OpenAI `{"type":"function","function":...}` structure.
   - Evidence: `langfn/typescript/src/client.ts:73-78`, `langfn/typescript/src/models/openai.ts:75-85`
4. Observability is not production-safe.
   - Python assigns one trace ID per `LangFn` instance and reuses it for every request and stream event, which collapses unrelated runs into a single trace namespace.
   - Python exposes `/traces`, but `get_traces()` is a placeholder returning `[]`.
   - TypeScript does not attach trace IDs or costs to responses in its client path, making feedback/tracing effectively unusable.
   - Evidence: `langfn/python/langfn/client.py:49`, `langfn/python/langfn/client.py:89-92`, `langfn/python/langfn/client.py:264-265`, `langfn/python/langfn/client.py:297-299`, `langfn/python/langfn/client.py:358-359`
5. Security hardening is materially incomplete.
   - HTTP routes have no built-in authentication, authorization, tenant scoping, or rate limiting.
   - The built-in `api_call` tool can perform arbitrary outbound requests with caller-controlled headers and body, enabling SSRF and credential forwarding scenarios.
   - Both calculator tools still use `eval`, leaving the package open to resource-exhaustion patterns and poor sandbox guarantees.
   - Evidence: `langfn/typescript/src/http/routes.ts:4-53`, `langfn/python/langfn/http/routes.py:10-19`, `langfn/typescript/src/tools/api_call.ts:11-27`, `langfn/python/langfn/tools/api_call.py:15-26`, `langfn/typescript/src/tools/calculator.ts:12-19`, `langfn/python/langfn/tools/calculator.py:14-27`
6. RAG storage is not scalable.
   - Both DB-backed vector stores fetch up to 100 candidate rows and do cosine reranking in process rather than using adapter-native vector search or an external vector service.
   - This is acceptable as a prototype but not for production-scale corpora or latency-sensitive retrieval.
   - Evidence: `langfn/typescript/src/rag/db-vector-store.ts:43-74`, `langfn/python/langfn/rag/db_vector_store.py:42-79`
7. Shared superfunctions reuse is only partial.
   - Positive: the code uses `@superfunctions/db`, `@superfunctions/http`, `superfunctions.db`, and `superfunctions.http`.
   - Gaps: there is no real `watchfn` integration layer, no `@superfunctions/auth` usage, no `cachefn` integration despite a custom cache, no `secfn` integration for secrets/redaction, no `testfn` integration, and durable memory remains duplicated instead of being moved behind a `memoryfn` boundary as proposed.
8. Packaging and versioning are inconsistent.
   - Python declares `version = "0.0.1"` in `pyproject.toml` but exports `__version__ = "0.1.0"` and both HTTP health handlers also report `0.1.0`.
   - TypeScript contains a `CostMeter` implementation but does not export it from `observability/index.ts`.
   - Python optional extras do not match the spec’s promised adapter/provider surface.
   - Evidence: `langfn/python/pyproject.toml:5-40`, `langfn/python/langfn/__init__.py:25`, `langfn/typescript/src/http/routes.ts:11`, `langfn/python/langfn/http/handlers.py:37`, `langfn/typescript/src/observability/index.ts:1-2`, `langfn/typescript/src/observability/cost-meter.ts:23-36`

## Mandatory Criteria Summary

| Criterion | Status | Summary |
| --- | --- | --- |
| Performance | FAIL | DB vector search is full-scan/rerank, Python provider clients recreate HTTP clients per request, and there is no proven TS build/test signal in this environment. |
| Scalability | FAIL | No multi-tenant scoping, no vector index usage, no rate limiting, no durable trace retrieval, and several APIs remain in-memory or placeholder-based. |
| Security | FAIL | No built-in auth/rate limiting on HTTP routes; arbitrary outbound `api_call` tool; `eval`-based calculator; no secfn-backed secrets or sanitization. |
| Code duplication | PARTIAL | Duplication is moderate rather than catastrophic, but provider/vector-store/agent logic is duplicated enough to increase maintenance drift. |
| Shared superfunctions code usage | PARTIAL | Good use of shared DB/HTTP abstractions; weak or absent reuse for auth, caching, security, watchfn, testfn, and memoryfn boundaries. |
| Packaging and abstraction | FAIL | TS package name/exports conflict with spec and docs; Python public exports and versioning are inconsistent; abstraction surface does not match examples. |

# Intent Inventory

1. `langfn` must exist as a comprehensive AI development SDK for LLM workflow needs.
2. It must follow repo-wide superfunctions conventions from `AGENTS.md`.
3. It must provide both TypeScript and Python SDKs.
4. It should combine capabilities comparable to langchain + langgraph + langsmith + langfuse.
5. It must provide model abstraction across major providers and local models.
6. It must provide orchestration primitives such as sequential, parallel, routing, and workflow composition.
7. It must provide graph-style stateful workflows.
8. It must provide tools/function calling support.
9. It must provide agent abstractions on top of tools/models.
10. It must provide prompt management, including templates and registry behavior.
11. It must provide observability and tracing, with watchfn integration.
12. It should provide structured output support.
13. It should provide streaming support.
14. It should provide retrieval/memory features, though the exact durable-memory boundary is contested by later specs.
15. It should provide evaluation/testing-oriented workflows.
16. It should expose framework-agnostic HTTP adapters instead of bundling framework-specific routers directly.
17. It should use shared superfunctions packages when those abstractions exist, instead of duplicating them.
18. It should be production-ready, including retries, error handling, rate limiting, security, and operational correctness.
19. It should be performant and scalable under realistic usage.
20. It should have coherent packaging, versioning, and abstraction surfaces that match documentation.
21. This audit must explicitly evaluate security.
22. This audit must explicitly evaluate code duplication.
23. This audit must explicitly evaluate shared superfunctions code usage.
24. This audit must explicitly evaluate packaging and abstraction quality.

# Intent -> Spec Coverage Matrix

| Intent ID | Intent | Spec mapping | Intent coverage in spec | Implementation status | Notes |
| --- | --- | --- | --- | --- | --- |
| I1 | Comprehensive AI SDK | `langfn/SPEC.md` overview/core features; `IMPLEMENTATION_SPEC.md` executive summary | PASS | PARTIAL | Broad scope is specified, but implementation is incomplete and inconsistent across languages. |
| I2 | Follow superfunctions conventions | `AGENTS.md`; `IMPLEMENTATION_SPEC.md` §4 | PASS | PARTIAL | Shared DB/HTTP abstractions are reused, but packaging naming and artifact/doc structure drift. |
| I3 | Dual TS + Python SDKs | `langfn/SPEC.md` architecture; `IMPLEMENTATION_SPEC.md` §2 | PASS | PARTIAL | Both SDK directories exist, but parity is poor and TS packaging blocks documented consumption. |
| I4 | Langchain + LangGraph + LangSmith/Langfuse-like surface | `langfn/SPEC.md` §§1-13 | PASS | PARTIAL | Many pieces exist in prototype form; several core surfaces are missing or broken. |
| I5 | Model abstraction | `langfn/SPEC.md` §1; `IMPLEMENTATION_SPEC.md` §3.1 | PASS | PARTIAL | OpenAI/Anthropic/Ollama exist; Google/Mistral/custom missing; config-first API from spec is absent. |
| I6 | Orchestration/workflows | `langfn/SPEC.md` §§4-5; `IMPLEMENTATION_SPEC.md` §§3.4-3.5 | PASS | PARTIAL | Python includes router; TS lacks router and several workflow features. |
| I7 | Graph workflows | `langfn/SPEC.md` §5; `IMPLEMENTATION_SPEC.md` §3.5 | PASS | PARTIAL | Basic graph engine exists; no checkpoints, interrupts, or visualization. |
| I8 | Tools/function calling | `langfn/SPEC.md` §3; `IMPLEMENTATION_SPEC.md` §3.3 | PASS | FAIL | Python tool loop works in tested cases; TS tool serialization/provider integration is broken. |
| I9 | Agents | `langfn/SPEC.md` §7; `IMPLEMENTATION_SPEC.md` §3.6 | PASS | PARTIAL | ReAct/ToolAgent exist; PlanExecute/MultiAgent do not. |
| I10 | Prompt management | `langfn/SPEC.md` §2; `IMPLEMENTATION_SPEC.md` §3.2 | PASS | PARTIAL | Basic templates/registry exist; Python exports are broken and registry save path is faulty. |
| I11 | Observability + watchfn | `langfn/SPEC.md` §9; `IMPLEMENTATION_SPEC.md` §3.7; `improvements.spec.md` §3 | PASS | FAIL | Python has partial tracer/cost/budget support; TS is minimal; trace retrieval and run isolation are not production safe. |
| I12 | Structured outputs | `improvements.spec.md` §2.2 | PASS | PARTIAL | Python does this reasonably; TS uses a minimal regex/JSON extraction path only. |
| I13 | Streaming | `langfn/SPEC.md` §10; `improvements.spec.md` §2.3 | PASS | PARTIAL | Basic content/end streaming exists; unified event taxonomy is not implemented. |
| I14 | Retrieval/memory | `langfn/SPEC.md` §§6,8; `improvements.spec.md` §§1,6,7 | SPEC CONFLICT | PARTIAL | Original spec wants durable memory/vector features; improvements spec wants those moved to `memoryfn`. |
| I15 | Evaluation | `langfn/SPEC.md` §11; `IMPLEMENTATION_SPEC.md` §3.8; `improvements.spec.md` §8 | PASS | PARTIAL | Basic evaluator exists; no robust experiment/testfn integration. |
| I16 | Framework-agnostic HTTP | `langfn/SPEC.md` §12; `IMPLEMENTATION_SPEC.md` §4.1 | PASS | PARTIAL | Uses shared HTTP abstractions, but routes are incomplete and unhardened. |
| I17 | Shared package reuse | `AGENTS.md`; `langfn/SPEC.md` dependencies; `IMPLEMENTATION_SPEC.md` §4 | PASS | PARTIAL | Good DB/HTTP reuse, weak or absent reuse of other relevant shared packages. |
| I18 | Production-ready hardening | `langfn/SPEC.md` core philosophy/§13; `improvements.spec.md` §§2.4-2.7, 4, 9, 10 | PASS | FAIL | Retries/cancellation exist mainly in Python, but auth, rate limit, sanitization, and observability are insufficient. |
| I19 | Performance + scalability | `langfn/SPEC.md` §13; `improvements.spec.md` §9 | PASS | FAIL | Candidate scans, no pool reuse proof, no multi-tenant limits, no scalable trace/storage story. |
| I20 | Packaging/versioning/abstraction | `AGENTS.md`; `langfn/SPEC.md` technology stack/deployment; `improvements.spec.md` §5 | PASS | FAIL | Package names, exports, versions, docs, and public abstractions do not line up. |
| I21 | Security auditability | conversation request; `improvements.spec.md` §§4,10 | PASS | FAIL | See cross-cutting security section. |
| I22 | Code duplication auditability | conversation request; `AGENTS.md` shared code guidance | SPEC MISSING | PARTIAL | Not directly specified as product behavior, but measurable in implementation. |
| I23 | Shared superfunctions usage auditability | conversation request; `AGENTS.md`; `IMPLEMENTATION_SPEC.md` §4 | PASS | PARTIAL | Reuse exists but is incomplete where the refined spec expects it. |
| I24 | Packaging/abstraction auditability | conversation request; `AGENTS.md`; `langfn/SPEC.md` technology/deployment | PASS | FAIL | See packaging/abstraction section. |

# Requirement Coverage Summary

No formal langfn `REQUIREMENTS.md` exists. The following counts use derived requirement IDs for audit traceability.

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED | SPEC CONFLICT | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Bundle A: `langfn/SPEC.md` (`A01-A20`) | 0 | 12 | 8 | 0 | 0 | Main spec is broad but only partially realized. |
| Bundle B: `langfn/.conduct/IMPLEMENTATION_SPEC.md` (`B01-B12`) | 0 | 10 | 2 | 0 | 0 | Implementation plan intent is directionally visible but not completed. |
| Bundle C: `langfn/.conduct/improvements.spec.md` (`C01-C15`) | 0 | 5 | 9 | 0 | 1 | Additive/refinement bundle is largely unimplemented; one major scope conflict exists. |

# Requirement-by-Requirement Results

## Bundle A: `langfn/SPEC.md`

| ID | Derived requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| A01 | Repository layout, dual SDK structure, docs surface | PARTIAL | `langfn/typescript/` and `langfn/python/` exist, but there is no root `langfn/README.md` or `langfn/docs/`, and spec-listed TS config files are absent. |
| A02 | TS package metadata/dependencies should align to `langfn` and spec exports | FAIL | Published name is `@langfn/core`, not `langfn`, with only `"."` exported. `langfn/typescript/package.json:2-14`. |
| A03 | Python package metadata and extras should align with spec | PARTIAL | Name is `langfn`, but extras are incomplete and versioning is inconsistent. `langfn/python/pyproject.toml:6-40`, `langfn/python/langfn/__init__.py:25`. |
| A04 | Model abstraction across providers with complete/chat/stream/withModel semantics | PARTIAL | OpenAI/Anthropic/Ollama exist; no Google/Mistral/custom, config-first API is absent, and TS lacks normalized errors. |
| A05 | Prompt management incl. templates, chat templates, few-shot, registry, versioning | PARTIAL | Basic pieces exist; Python exports are broken, Python registry save path references missing attrs, and TS latest-version semantics are undefined. `langfn/python/langfn/prompts/registry.py:36-46`, `langfn/typescript/src/prompts/registry.ts:46-56`. |
| A06 | Tools and function calling should work with providers and agents | FAIL | TS tool serialization/provider path is broken; Python basic tool flow works in tests but HTTP/tool API parity is incomplete. |
| A07 | Chains and orchestration should include sequential, parallel, map-reduce, router | PARTIAL | Python has all four; TS lacks router. |
| A08 | Graph workflows should support conditional edges and compiled execution | PARTIAL | Basic compile/invoke exists; no checkpoints, interrupts, executor abstraction, or visualization. |
| A09 | RAG should include retriever/indexing/reranking/vector-store chain support | FAIL | Only embeddings + vector stores exist. No retriever abstraction usage in high-level API, no chunking/indexing/reranking, no RAG chain constructor. |
| A10 | Agents should include ReAct + PlanExecute + multi-agent collaboration | PARTIAL | ReAct and ToolAgent exist; PlanExecute and multi-agent do not. |
| A11 | Memory management should include buffer/summary/vector/entity/conversation | PARTIAL | Buffer and summary exist; vector is implemented under RAG; entity/conversation chain surfaces are absent. |
| A12 | Observability/tracing should expose watchfn-backed traces, metrics, feedback | FAIL | Python trace retrieval is placeholder; TS has no real trace attachment; watchfn integration is ad hoc rather than productized. |
| A13 | Streaming should support iterator/SSE/WebSocket and tool-aware events | PARTIAL | Iterator and SSE exist; no WebSocket surface or unified tool-aware stream model. |
| A14 | Evaluation and experimentation should support metrics/comparisons | PARTIAL | Basic evaluator exists in both languages; no robust experiment/custom-metric parity. |
| A15 | HTTP API should expose complete/chat/stream/embed/traces/feedback | FAIL | TS exposes only `/health`, `/complete`, `/chat`; Python omits `/stream` and chat tools. |
| A16 | Caching/performance/rate limiting should be built in | FAIL | Cache exists, but rate limiting is absent; retries/cost/budgets are Python-only; scalable performance work is not present. |
| A17 | Database schema expectations should be supported | PARTIAL | Storage classes imply table names, but there are no schemas/migrations or readiness checks. |
| A18 | Python SDK examples should be supported in public API | FAIL | Public imports used by tests/examples are broken (`Budgets`, `CostMeter`, `DatasetItem`, `ChatTemplate`). |
| A19 | Deployment/install instructions should be accurate | FAIL | TS package name and subpath exports make the documented install/import path invalid; Python extras are incomplete. |
| A20 | Verification plan should include real automated confidence | PARTIAL | There are unit tests, but the full Python suite fails collection and TS tests/builds were not runnable in this workspace. |

### Bundle A Notes

- The main spec presents a 1.0-style platform surface, but the implementation is still prototype-grade in multiple key areas.
- The broadest gap is not just “missing features”; it is that some existing documented surfaces are currently misleading because the package/import contracts do not match reality.

## Bundle B: `langfn/.conduct/IMPLEMENTATION_SPEC.md`

| ID | Derived requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| B01 | Dual SDK directory structure should exist | PARTIAL | Both SDK roots exist, but TS packaging and Python export stability are incomplete. |
| B02 | Model abstraction should provide unified chat/completion/embedding providers | PARTIAL | Core abstractions exist, but provider set and production hardening are incomplete. |
| B03 | Prompt management should be type-safe and registry-backed | PARTIAL | Basic templates and registries exist; Python registry save path is broken. |
| B04 | Tools/function calling should be standardized and production usable | FAIL | TS tool serialization/provider path is broken; builtins are not hardened. |
| B05 | Orchestration should support sequential/parallel/map-reduce/router | PARTIAL | Python satisfies this better than TS. |
| B06 | Graph workflows should support cyclic/stateful flows | PARTIAL | Basic engine exists without advanced operational features. |
| B07 | Agents should expose prebuilt architectures | PARTIAL | ReAct/ToolAgent only. |
| B08 | Observability should provide tracing and watchfn integration | FAIL | Tracing correctness and retrieval are insufficient; TS is especially underpowered. |
| B09 | Memory + RAG should cover context retention and retrieval | PARTIAL | Prototype stores exist, but not at production depth and with later scope conflict. |
| B10 | HTTP adapters should remain framework-agnostic via shared abstractions | PARTIAL | Shared HTTP abstractions are used, but feature completeness and hardening are insufficient. |
| B11 | Storage should use shared DB abstractions | PARTIAL | Shared DB abstractions are used in both languages. |
| B12 | Development standards/testing should produce confidence | PARTIAL | Some targeted tests pass, but the full suite and TS verification are not release-grade signals. |

## Bundle C: `langfn/.conduct/improvements.spec.md`

| ID | Derived requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| C01 | Durable memory should move behind a `memoryfn` boundary, leaving ephemeral memory in langfn | SPEC CONFLICT | Conflicts with the main spec, which still includes vector store and long-term memory surfaces inside langfn. Current code still keeps DB/in-memory vector stores in langfn. |
| C02 | MCP should be first-class | PARTIAL | Python ships a stdio MCP client/server path; TS has no MCP surface, and the refined spec’s SSE/OAuth/tool-health scope is absent. |
| C03 | Structured outputs should be provider-agnostic and typed | PARTIAL | Python has a decent typed parser; TS has a minimal regex-based parser only. |
| C04 | Unified streaming shape with content/tool_call/tool_result/token_usage/trace/reasoning/end | FAIL | Python defines event types but models only emit content/end in practice; TS stream types only include content/end/error. |
| C05 | Cancellation and abort control should be supported | PARTIAL | Python supports timeout/cancel tokens; TS does not. |
| C06 | Cost tracking and budget enforcement should be built in | PARTIAL | Python supports both; TS has a `CostMeter` file but does not wire or export it in the public surface. |
| C07 | Normalized error model should exist across providers | PARTIAL | Python has a useful error hierarchy; TS still throws raw `Error`. |
| C08 | Batch processing should support concurrency and partial results | PARTIAL | Python and TS both have simple `complete_batch` equivalents, but provider-native batching and retry semantics are absent. |
| C09 | Observability enhancements should include taxonomy, OTEL, redaction, better watchfn | FAIL | Python has partial redaction/exporter scaffolding; no OTEL bridge or end-to-end taxonomy adoption. |
| C10 | HTTP should integrate auth/rate limiting hardening | FAIL | No built-in auth or rate limiting in either language’s HTTP route layer. |
| C11 | Multi-tenant context headers should propagate to traces/cache/memory | FAIL | Not implemented. |
| C12 | Repo structure/docs should move spec artifacts under `.conduct` and ship better docs | FAIL | `langfn/SPEC.md` remains at root, and the expected docs tree is missing. |
| C13 | TestFn/provider compatibility coverage should exist | FAIL | No `testfn` integration or provider compatibility matrix. |
| C14 | Performance optimizations should include pooling, batching, cachefn | FAIL | No proven pooling strategy, no cachefn integration, and retrieval remains in-process reranking. |
| C15 | Security enhancements should include secfn, validation, sanitization | FAIL | No secfn integration, no route auth, and no output sanitization pipeline. |

# Spec Conflicts / Spec Gaps

## Explicit Spec Conflicts

1. Durable memory / RAG boundary
   - `langfn/SPEC.md` places vector stores, memory, and RAG features inside `langfn`.
   - `langfn/.conduct/improvements.spec.md` proposes moving durable memory and vector-store ownership to `memoryfn`, keeping only ephemeral memory and retriever abstractions in `langfn`.
   - Current implementation still owns DB-backed and in-memory vector stores in both languages.
   - Result: `SPEC CONFLICT` for long-term memory ownership and release scope.

2. Artifact placement
   - `langfn/SPEC.md` lives at repo root under `langfn/`.
   - `improvements.spec.md` proposes moving the main spec into `langfn/.conduct/`.
   - Current repo remains in the older placement.

## Explicit Spec Gaps

1. No formal `REQUIREMENTS.md`
   - This forced derived requirement IDs for the audit.
2. No formal langfn test-vector bundle
   - Verification relied on available unit tests plus static inspection.
3. The user-requested code-duplication criterion is not represented as a product requirement in the spec bundle
   - It is only indirectly implied by `AGENTS.md` shared-code guidance.

# Cross-Cutting Audits

## Security / Authz / Validation Boundaries

Status: FAIL

Findings:

- HTTP route layers provide no built-in authentication or authorization hooks.
  - TS: `langfn/typescript/src/http/routes.ts:4-53`
  - Python: `langfn/python/langfn/http/routes.py:10-19`
- The `api_call` tool enables arbitrary network egress with caller-controlled URL and headers, which is a classic SSRF and credential-forwarding hazard.
  - TS: `langfn/typescript/src/tools/api_call.ts:11-27`
  - Python: `langfn/python/langfn/tools/api_call.py:15-26`
- Both calculator tools rely on `eval`.
  - TS sanitizes characters, but still allows expensive expressions and does not provide a real parser or execution budget.
  - Python similarly allows arbitrary arithmetic expressions with no complexity cap.
  - TS: `langfn/typescript/src/tools/calculator.ts:12-19`
  - Python: `langfn/python/langfn/tools/calculator.py:14-27`
- No `secfn` integration exists for secrets retrieval, input redaction, or output sanitization despite the improvements spec explicitly calling for it.
- No route-level tenant/user/run scoping is implemented.

## Determinism Invariants

Status: FAIL

Findings:

- Python trace IDs are generated once per `LangFn` instance and reused for every response and stream event.
  - `langfn/python/langfn/client.py:49`, `langfn/python/langfn/client.py:264-265`, `langfn/python/langfn/client.py:297-299`, `langfn/python/langfn/client.py:358-359`
- TS cache keys hash raw `JSON.stringify(metadata)` without key sorting, so logically equivalent metadata objects can produce different cache keys depending on property insertion order.
  - `langfn/typescript/src/storage/cache.ts:11-17`
- TS prompt registry “latest” load behavior is nondeterministic because it queries by name only and does not specify any ordering or version resolution rule.
  - `langfn/typescript/src/prompts/registry.ts:46-56`

## Limits / Caps

Status: FAIL

Findings:

- No built-in HTTP rate limiting or token caps exist in route layers.
- DB vector store retrieval hard-limits candidates to 100 rows and reranks in memory.
  - TS: `langfn/typescript/src/rag/db-vector-store.ts:56-60`
  - Python: `langfn/python/langfn/rag/db_vector_store.py:52-57`
- Summary memory still uses a message-count heuristic / placeholder instead of real token budgeting.
  - TS: `langfn/typescript/src/memory/summary.ts:18-27`
  - Python: `langfn/python/langfn/memory/summary.py:21-24`
- TS has no structured cancellation or timeout handling.

## Error Handling + Canonical Envelopes

Status: PARTIAL

Findings:

- Python has a useful normalized error hierarchy and retry integration.
  - `langfn/python/langfn/core/errors.py`
  - `langfn/python/langfn/utils/retry.py`
- TS providers still throw generic `Error`, which weakens retryability and API-consumer ergonomics.
  - `langfn/typescript/src/models/openai.ts:53-56`
  - `langfn/typescript/src/models/anthropic.ts:45-47`
  - `langfn/typescript/src/models/ollama.ts:36-39`
- Neither language currently provides a robust canonical HTTP error envelope for route failures.

## Compatibility / Versioning / Migrations

Status: FAIL

Findings:

- Python version metadata disagrees internally:
  - `langfn/python/pyproject.toml:7` -> `0.0.1`
  - `langfn/python/langfn/__init__.py:25` -> `0.1.0`
- Health handlers also report `0.1.0`, diverging from package metadata.
  - TS: `langfn/typescript/src/http/routes.ts:11`
  - Python: `langfn/python/langfn/http/handlers.py:37`
- No DB schema/migration assets are provided even though multiple tables are implied by the spec and storage layers.
- TS peer-dependency and subpath export model does not match the spec examples for adapters and module imports.

## Performance

Status: FAIL

Findings:

- Retrieval path is O(candidate_count) CPU work in process for every DB search.
- Python providers instantiate a new `httpx.AsyncClient` on every call path rather than proving a shared pooled transport strategy.
- TS `completeBatch()` is a naive chunked `Promise.all()` loop with no partial-failure metadata, no rate shaping, and no provider-native batching.
- TS verification was not executable in this workspace because the package-local toolchain was unavailable; therefore no empirical TS performance signal was established.

## Scalability

Status: FAIL

Findings:

- No multi-tenant isolation model or context propagation exists.
- No scalable trace retrieval/persistence path exists on the Python public client (`get_traces()` is a placeholder).
- No vector index integration or external retrieval service usage is present.
- Several high-level surfaces are still in-memory only (summary memory, vector memory, agent loops).

## Security

Status: FAIL

Summary:

- No built-in auth/rate limiting on route layers
- SSRF-capable outbound tool
- `eval`-based calculator tools
- incomplete redaction/secrets/sanitization story
- no secfn/auth package integration where the refined spec expects it

## Code Duplication Status

Status: PARTIAL

Empirical result from `npx jscpd langfn --min-lines 10 --min-tokens 50 --reporters console`:

- TypeScript: 6 clones, 120 duplicated lines, 6.02% duplicated lines
- Python: 5 clones, 64 duplicated lines, 1.82% duplicated lines
- Total: 11 clones, 184 duplicated lines, 3.34% duplicated lines

Notable duplication clusters:

- provider request/response handling across TS OpenAI/Anthropic/Ollama models
- provider streaming handling across TS models
- cosine similarity logic duplicated between in-memory and DB vector stores in both languages
- agent control loops duplicated between `ToolAgent` and `ReActAgent`

Assessment:

- Current duplication is not the main release blocker.
- It is, however, already high enough in TypeScript to increase drift risk, especially because provider/tool behavior is not covered by strong TS tests.

## Shared Superfunctions Code Usage

Status: PARTIAL

Good reuse:

- `@superfunctions/db` used in TS prompt registry, trace storage, cache, and DB vector store
- `@superfunctions/http` used in TS HTTP routes
- `superfunctions.db` used in Python prompt registry, trace storage, cache, and DB vector store
- `superfunctions.http` used in Python routes/handlers

Gaps / missed reuse opportunities:

- no real `watchfn` integration layer or exported observability adapter surface
- no `@superfunctions/auth` or equivalent auth middleware integration
- no `cachefn` usage despite a custom response cache implementation
- no `secfn` usage for secrets, redaction policies, or sanitization
- no `testfn` integration for evaluation/provider compatibility
- durable retrieval/memory ownership remains inside `langfn` instead of using the refined `memoryfn` boundary

Overall assessment:

- The project correctly reuses the shared HTTP and DB abstractions.
- Beyond those two, it largely reimplements or postpones cross-cutting concerns instead of adopting the wider superfunctions ecosystem the specs call for.

## Packaging and Abstraction

Status: FAIL

Findings:

- TS package name is `@langfn/core`, while the spec and README tell consumers to install/import `langfn`.
- TS exports only `"."`; documented subpath imports are impossible from the published package shape.
- TS public surface does not expose `CostMeter` via `observability/index.ts`.
- Python public surfaces in `observability`, `evaluation`, and `prompts` are not internally consistent.
- Python prompt registry save path targets nonexistent private attrs (`_template`, `_variables`) instead of the dataclass fields (`template`, `variables`).
  - `langfn/python/langfn/prompts/registry.py:36-46`
- Root-level documentation/package surface is incomplete relative to the spec; only language-specific READMEs exist.

# Recommendations

1. Fix package/public API contract breaks first.
   - Align TS package name and export map with the spec or update all specs/docs to the real package identity.
   - Repair Python `__init__` module exports so the public API matches tests/examples.
   - Normalize version metadata across package manifests, module constants, and HTTP health responses.
2. Make tool calling actually work in both languages.
   - Fix TS `LangFn.chat()` tool serialization ordering.
   - Transform provider tool specs to provider-native formats.
   - Add end-to-end tool-calling tests for providers and HTTP surfaces.
3. Correct observability semantics before adding more surface area.
   - Generate per-request/per-run trace IDs, not per-client-instance IDs.
   - Implement actual trace persistence/retrieval.
   - Export cost/budget surfaces properly and make feedback paths work against real trace records.
4. Close the core security gaps.
   - Add auth/rate limiting hooks to HTTP route construction.
   - Replace or strictly sandbox/remove `eval`-based calculator implementations.
   - Add allowlists and SSRF protections to `api_call`.
   - Add secfn-backed secret access and explicit sanitization/redaction flows.
5. Resolve the memory-scope spec conflict explicitly.
   - Decide whether durable memory/vector search remains in `langfn` or moves to `memoryfn`.
   - Then delete or refactor the losing side; do not keep both the broad and narrow interpretations open.
6. Address scalability/performance architecture.
   - Use adapter-native vector search or offload durable retrieval.
   - Prove connection reuse/pooling on provider clients.
   - Add rate limiting and batching strategies with measurable acceptance targets.
7. Strengthen verification and packaging before any production claim.
   - Restore full Python suite collection.
   - Make TS build/test runnable and documented from the monorepo root.
   - Add provider compatibility tests, HTTP integration tests, and release-gate checks.

# Appendix: Commands Run + Environment Details

## Environment details

- repo root: `repo root`
- git branch state: detached HEAD
- git commit: `7adae77`
- dirty status: clean
- os: `Darwin arm64`
- shell: `zsh`

## Verification command outcomes

1. `npm test` from `langfn/typescript/`
   - Result: failed immediately because `vitest` was not available in the current environment.
   - Audit interpretation: TS runtime verification in this workspace is unverified, not cleanly passing.
2. `npm run build` from `langfn/typescript/`
   - Result: failed immediately because `tsup` was not available in the current environment.
   - Audit interpretation: TS package build remains unverified here.
3. `python3 -m pytest` from `langfn/python/`
   - Result: collection stopped with 4 import/export errors:
     - `langfn.observability` missing `Budgets`
     - `langfn.observability` missing `CostMeter`
     - `langfn.evaluation` missing `DatasetItem`
     - `langfn.prompts` importing `ChatPromptTemplate` from a module that does not define it
4. `python3 -m pytest tests/test_prompt_and_structured.py tests/test_chain.py tests/test_tool_agent.py tests/test_openai_provider.py -q`
   - Result: 9 passed
5. `python3 -m pytest tests/test_basics.py`
   - Result: 3 passed
6. `python3 -m pytest tests/test_mcp_stdio.py -q`
   - Result: did not complete within the observed window
7. manual MCP smoke script
   - Result: passed `list_tools`, `call_tool("add")`, and `close()`
8. `npx jscpd langfn --min-lines 10 --min-tokens 50 --reporters console`
   - Result: duplication summary captured in the code-duplication section

## Final assessment

Release recommendation: do not ship to production in the current state.

Blocking themes:

- packaging/public API correctness
- TS tool and packaging correctness
- Python public module stability
- security hardening
- observability correctness
- scalability architecture
