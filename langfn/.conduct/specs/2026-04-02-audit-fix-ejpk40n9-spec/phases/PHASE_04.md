# Phase goal

Complete LangFn orchestration, graph, and agent execution so sequential chains, routers, graphs, and advanced agents behave deterministically in both languages.

# In scope

- Sequential, parallel, map-reduce, and router chains.
- State graph compile/invoke/checkpoint/interrupt/resume behavior.
- ToolAgent, ReActAgent, PlanExecuteAgent, and multi-agent coordinator parity.
- Canonical graph/agent failure handling and iteration limits.

# Out of scope

- Durable retrieval backends and memoryfn integration.
- HTTP route exposure, MCP transports, and release-gate documentation.

# Deliverables

- `langfn/typescript/src/orchestration/chain.ts`
- `langfn/typescript/src/orchestration/router.ts`
- `langfn/typescript/src/orchestration/parallel.ts`
- `langfn/typescript/src/orchestration/index.ts`
- `langfn/typescript/src/graph/state_graph.ts`
- `langfn/typescript/src/graph/checkpoint.ts`
- `langfn/typescript/src/graph/index.ts`
- `langfn/typescript/src/agents/react.ts`
- `langfn/typescript/src/agents/tool_agent.ts`
- `langfn/typescript/src/agents/plan_execute.ts`
- `langfn/typescript/src/agents/multi_agent.ts`
- `langfn/typescript/src/agents/index.ts`
- `langfn/typescript/tests/orchestration-graph-agent.test.ts`
- `langfn/python/langfn/orchestration/chain.py`
- `langfn/python/langfn/orchestration/router.py`
- `langfn/python/langfn/orchestration/parallel.py`
- `langfn/python/langfn/orchestration/__init__.py`
- `langfn/python/langfn/graph/state_graph.py`
- `langfn/python/langfn/graph/checkpoint.py`
- `langfn/python/langfn/graph/__init__.py`
- `langfn/python/langfn/agents/react.py`
- `langfn/python/langfn/agents/tool_agent.py`
- `langfn/python/langfn/agents/plan_execute.py`
- `langfn/python/langfn/agents/multi_agent.py`
- `langfn/python/langfn/agents/__init__.py`
- `langfn/python/tests/test_chain.py`
- `langfn/python/tests/test_graph_and_eval_and_tracer.py`

# Requirements covered

- `ORCH-001`
- `GRAPH-001`
- `AGENT-001`
- `AGENT-002`

# Implementation tasks

1. Implement sequential, parallel, map-reduce, and router chain primitives with deterministic ordering and bounded concurrency controls.
2. Extend state graph execution to support named nodes, static edges, conditional edges, checkpoints, interrupts, resumes, and max-step enforcement.
3. Add ReAct transcript preservation and make tool-loop history append-only across each agent iteration.
4. Implement PlanExecuteAgent with explicit planner/executor phases and deterministic failure handling when planning cannot continue.
5. Implement a bounded multi-agent coordinator that routes work among named agents without unbounded recursion or hidden planner calls.
6. Normalize graph and agent failures into canonical errors rather than raw exceptions.
7. Add deterministic graph/orchestration/agent tests using mock models and fixed routes/plans.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/orchestration-graph-agent.test.ts`.
   Expected outcome: TypeScript orchestration, graph, and agent suites pass with deterministic results.
2. Run `python3 -m pytest langfn/python/tests/test_chain.py langfn/python/tests/test_graph_and_eval_and_tracer.py -q`.
   Expected outcome: Python chain, graph, and agent behavior passes, including checkpoint/resume coverage.

# Stop condition

- Stop after orchestration primitives, graph execution, and advanced agents are all implemented with deterministic limits and the listed verification suites pass in both languages.
