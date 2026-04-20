# Phase goal

Complete canonical streaming and observability so every LangFn invocation yields fresh traces, structured stream events, persisted feedback, redacted exports, and cost/budget controls.

# In scope

- Canonical streaming event taxonomy and SSE normalization.
- Trace creation, span persistence, query, and feedback linkage.
- Cost metering, budgets, redaction, and watchfn/OTLP export hooks.
- Cross-language observability API parity.

# Out of scope

- HTTP auth/rate-limit middleware.
- MCP transport surfaces and evaluation datasets.

# Deliverables

- `langfn/typescript/src/streaming/sse.ts`
- `langfn/typescript/src/observability/tracer.ts`
- `langfn/typescript/src/observability/storage.ts`
- `langfn/typescript/src/observability/cost-meter.ts`
- `langfn/typescript/src/observability/exporter.ts`
- `langfn/typescript/src/observability/redaction.ts`
- `langfn/typescript/src/observability/span-types.ts`
- `langfn/typescript/src/observability/index.ts`
- `langfn/typescript/src/client.ts`
- `langfn/typescript/tests/streaming-observability.test.ts`
- `langfn/python/langfn/streaming/sse.py`
- `langfn/python/langfn/observability/tracer.py`
- `langfn/python/langfn/observability/storage.py`
- `langfn/python/langfn/observability/cost_meter.py`
- `langfn/python/langfn/observability/budgets.py`
- `langfn/python/langfn/observability/exporter.py`
- `langfn/python/langfn/observability/redaction.py`
- `langfn/python/langfn/observability/span_types.py`
- `langfn/python/langfn/observability/__init__.py`
- `langfn/python/langfn/client.py`
- `langfn/python/tests/test_graph_and_eval_and_tracer.py`
- `langfn/python/tests/test_budgets_retry_http.py`

# Requirements covered

- `STREAM-001`
- `OBS-001`
- `OBS-002`
- `SEC-001`

# Implementation tasks

1. Normalize all streamed provider and agent output into the canonical event types defined in `STREAM-001`.
2. Ensure each invocation creates a fresh trace ID and propagates it through responses, stream events, spans, and feedback.
3. Replace placeholder trace-query implementations with real storage-backed query paths using shared DB abstractions.
4. Implement cost metering and budget enforcement that attach to completion/chat results when configured.
5. Add redaction filters that run before persistence or export and wire watchfn plus optional OTLP export through the same redacted payloads.
6. Expose the missing observability public exports so cost/budget surfaces are first-class in both languages.
7. Add focused stream/trace/feedback tests that assert terminal events, fresh trace IDs, idempotent feedback, budget overflow, and redaction.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/streaming-observability.test.ts`.
   Expected outcome: TypeScript streaming and observability tests pass, including cost/budget and redaction coverage.
2. Run `python3 -m pytest langfn/python/tests/test_graph_and_eval_and_tracer.py langfn/python/tests/test_budgets_retry_http.py -q`.
   Expected outcome: Python trace, budget, feedback, and redaction tests pass.

# Stop condition

- Stop after every invocation gets a fresh persisted trace, stream events are canonical, budgets/redaction/export work correctly, and the verification suites pass.
