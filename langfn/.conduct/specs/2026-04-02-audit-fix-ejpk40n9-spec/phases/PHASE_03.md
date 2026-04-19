# Phase goal

Repair tool-calling fidelity and make the built-in LangFn tools safe by default across both languages.

# In scope

- Canonical tool schema definition and provider-native serialization.
- Assistant tool-call to tool-result round-tripping with stable IDs and ordering.
- Safety hardening for `calculator`, `api_call`, `web_search`, and `code_exec`.
- Tool policy enforcement and canonical tool errors.

# Out of scope

- Multi-agent planning/coordinator behavior beyond single tool-loop execution.
- HTTP route auth/rate-limit enforcement.

# Deliverables

- `langfn/typescript/src/tools/base.ts`
- `langfn/typescript/src/tools/index.ts`
- `langfn/typescript/src/tools/policy.ts`
- `langfn/typescript/src/tools/calculator.ts`
- `langfn/typescript/src/tools/api_call.ts`
- `langfn/typescript/src/tools/web_search.ts`
- `langfn/typescript/src/tools/code_exec.ts`
- `langfn/typescript/src/models/openai.ts`
- `langfn/typescript/src/models/anthropic.ts`
- `langfn/typescript/src/client.ts`
- `langfn/typescript/src/agents/tool_agent.ts`
- `langfn/typescript/tests/tool-agent.test.ts`
- `langfn/python/langfn/tools/base.py`
- `langfn/python/langfn/tools/__init__.py`
- `langfn/python/langfn/tools/policy.py`
- `langfn/python/langfn/tools/calculator.py`
- `langfn/python/langfn/tools/api_call.py`
- `langfn/python/langfn/tools/web_search.py`
- `langfn/python/langfn/tools/code_exec.py`
- `langfn/python/langfn/models/openai.py`
- `langfn/python/langfn/models/anthropic.py`
- `langfn/python/langfn/client.py`
- `langfn/python/langfn/agents/tool_agent.py`
- `langfn/python/tests/test_tool_agent.py`
- `langfn/python/tests/test_budgets_retry_http.py`

# Requirements covered

- `TOOL-001`
- `TOOL-002`
- `SEC-001`

# Implementation tasks

1. Define one provider-neutral tool schema per language and map it to provider-native payloads before issuing provider requests.
2. Fix the TypeScript provider/client boundary so serialized tool definitions are the objects sent to providers rather than the raw caller input.
3. Validate tool arguments against the declared schema before execution and return canonical `TOOL_SCHEMA_ERROR` failures on mismatch.
4. Preserve `toolCallId`/`tool_call_id`, tool argument payloads, and tool result ordering across assistant and tool transcript messages.
5. Replace `eval`-based calculator execution with a bounded expression parser shared across tests.
6. Add outbound policy enforcement for `api_call`, including loopback, RFC1918, link-local, and metadata-service blocking unless explicitly allowed.
7. Require an explicit backend for `web_search` and an explicit sandbox executor for `code_exec`, otherwise fail with canonical disabled/not-configured errors.
8. Add deterministic tool-agent tests for OpenAI and Anthropic serialization, builtin-tool safety policy, and transcript round-tripping.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/tool-agent.test.ts`.
   Expected outcome: TypeScript tool-calling and builtin safety tests pass, including provider serialization assertions.
2. Run `python3 -m pytest langfn/python/tests/test_tool_agent.py langfn/python/tests/test_budgets_retry_http.py -q`.
   Expected outcome: Python tool execution and safety-policy tests pass.
3. Run `PYTHONPATH=langfn/python python3 -c "from langfn.tools import calculator; assert calculator('2 + 2') == '4'"`.
   Expected outcome: the calculator smoke command succeeds without relying on `eval`.

# Stop condition

- Stop after providers receive canonical tool payloads, assistant/tool transcripts preserve IDs and ordering, unsafe builtin paths are blocked by default, and all verification commands pass.
