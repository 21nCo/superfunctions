# Phase goal

Add full MCP and evaluation parity so LangFn supports model-context protocol transports and experiment/report workflows in both languages.

# In scope

- MCP client/server surfaces with stdio and SSE transports.
- Canonical MCP tool discovery/call envelopes and graceful shutdown semantics.
- Evaluation datasets, metrics, compare flows, and testfn export hooks.
- Cross-language public API parity for MCP and evaluation modules.

# Out of scope

- HTTP auth/rate-limit surface hardening.
- Release-gate docs and full performance tuning.

# Deliverables

- `langfn/typescript/src/mcp/index.ts`
- `langfn/typescript/src/mcp/client.ts`
- `langfn/typescript/src/mcp/server.ts`
- `langfn/typescript/src/mcp/stdio.ts`
- `langfn/typescript/src/mcp/sse.ts`
- `langfn/typescript/src/mcp/types.ts`
- `langfn/typescript/src/evaluation/index.ts`
- `langfn/typescript/src/evaluation/evaluator.ts`
- `langfn/typescript/src/evaluation/dataset.ts`
- `langfn/typescript/src/evaluation/metrics.ts`
- `langfn/typescript/src/index.ts`
- `langfn/typescript/tests/mcp-and-eval.test.ts`
- `langfn/python/langfn/mcp/__init__.py`
- `langfn/python/langfn/mcp/client.py`
- `langfn/python/langfn/mcp/server.py`
- `langfn/python/langfn/mcp/stdio.py`
- `langfn/python/langfn/mcp/types.py`
- `langfn/python/langfn/evaluation/__init__.py`
- `langfn/python/langfn/evaluation/dataset.py`
- `langfn/python/langfn/evaluation/evaluator.py`
- `langfn/python/langfn/evaluation/metrics.py`
- `langfn/python/tests/test_mcp_stdio.py`
- `langfn/python/tests/test_graph_and_eval_and_tracer.py`

# Requirements covered

- `MCP-001`
- `EVAL-001`

# Implementation tasks

1. Implement the missing TypeScript MCP module and align its public surface with the existing Python MCP API.
2. Add stdio and SSE transport support with canonical transport/protocol errors and deterministic tool list/call envelopes.
3. Ensure MCP shutdown closes underlying child processes or sockets cleanly without hanging.
4. Export dataset item models, exact-match/custom metrics, evaluator compare flows, and aggregate reporting in both languages.
5. Add a testfn adapter or export hook so evaluation results can be forwarded into the superfunctions testing ecosystem.
6. Add deterministic MCP and evaluation tests covering tool listing, tool invocation, shutdown, dataset exports, and compare workflows.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/mcp-and-eval.test.ts`.
   Expected outcome: the TypeScript MCP/evaluation suite passes for stdio, SSE, datasets, and compare flows.
2. Run `python3 -m pytest langfn/python/tests/test_mcp_stdio.py langfn/python/tests/test_graph_and_eval_and_tracer.py -q`.
   Expected outcome: the Python MCP and evaluation suites pass with no hanging shutdown behavior.

# Stop condition

- Stop after both languages expose MCP client/server surfaces plus evaluation/reporting workflows and the verification commands pass end to end.
