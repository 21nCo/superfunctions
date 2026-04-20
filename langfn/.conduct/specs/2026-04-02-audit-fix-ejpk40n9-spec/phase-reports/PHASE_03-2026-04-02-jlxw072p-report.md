# PHASE_03 Completion Report

- Timestamp: `2026-04-02T17:23:30Z`
- Agent: `unknown-agent`
- Model: `gpt-5-codex`
- Launcher: `Codex Desktop`
- Repo root: `.`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git: branch `HEAD` (detached), commit `7adae77`, dirty `true`
- Phase: `PHASE_03`
- Status: `PASS`

## Requirements summary

- Requirements delivered: `TOOL-001`, `TOOL-002`, `SEC-001`

### `TOOL-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Provider-neutral tool schemas serialize correctly for both OpenAI and Anthropic.
    - Python: `langfn/python/tests/test_tool_agent.py::test_openai_and_anthropic_receive_provider_native_tool_payloads`
    - TypeScript: `langfn/typescript/tests/tool-agent.test.ts` provider serialization case
  - Tool arguments are validated before execution and canonical schema failures are raised.
    - Python: `langfn/python/tests/test_tool_agent.py::test_tool_agent_invalid_tool_args_raise_tool_schema_error`
    - TypeScript: `langfn/typescript/tests/tool-agent.test.ts` invalid-args case throws `ToolSchemaError`
  - Tool result history preserves `tool_call_id` ordering through the agent loop.
    - Python: `langfn/python/tests/test_tool_agent.py::test_tool_agent_runs_tool_and_preserves_tool_call_history`
    - TypeScript: `langfn/typescript/tests/tool-agent.test.ts` tool-call history case
  - Unknown tools fail with canonical execution errors instead of raw exceptions.
    - Python: `langfn/python/tests/test_tool_agent.py::test_tool_agent_unknown_tool_raises_tool_execution_error`
    - TypeScript: `langfn/typescript/tests/tool-agent.test.ts` unknown-tool case throws `ToolExecutionError`

### `TOOL-002`

- Status: `PASS`
- Acceptance criteria evidence:
  - `calculator` rejects disallowed grammar without `eval`.
    - Python implementation uses an `ast` allowlist in `langfn/python/langfn/tools/calculator.py`
    - TypeScript implementation uses a recursive-descent parser in `langfn/typescript/src/tools/calculator.ts`
  - `api_call` blocks metadata/loopback/private-network targets unless policy allows them.
    - Python: `langfn/python/tests/test_budgets_retry_http.py::test_builtin_tool_policy_and_security_helpers`
    - TypeScript: `langfn/typescript/tests/tool-agent.test.ts` built-in safety case
  - `web_search` fails with `NOT_CONFIGURED` when no backend is configured.
    - Verified in both language test suites above
  - `code_exec` fails with `TOOL_DISABLED` when no sandbox executor is configured.
    - Verified in both language test suites above

### `SEC-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Secret lookup hooks exist for provider credentials and HTTP auth secrets.
    - Python provider models resolve `api_key_ref` through `resolve_secret(...)`
    - TypeScript provider models resolve `apiKeyRef` through `resolveSecret(...)`
    - TypeScript `api_call` test verifies `auth_secret_ref` populates `Authorization: Bearer ...`
  - Redaction helpers are available for sensitive payload fields before persistence/export boundaries.
    - Python: `langfn/python/langfn/tools/policy.py::redact_sensitive_fields`
    - TypeScript: `langfn/typescript/src/tools/policy.ts::redactSensitiveFields`
    - Both are exercised in phase tests with `authorization` and `ssn`
  - Output sanitization policies can be applied to tool results and HTTP responses.
    - Python tool base sanitizes results through `ToolPolicy.sanitize(...)`
    - TypeScript tool base sanitizes results through `ToolPolicy.sanitize(...)`
    - TypeScript tests verify `<script>` output is normalized to `safe string`
  - Security-policy failures use canonical error codes.
    - Both implementations now raise `TOOL_POLICY_VIOLATION`, `TOOL_DISABLED`, and `NOT_CONFIGURED` for the scoped failure modes

## Deliverables summary

- Files changed/added:
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
  - `langfn/python/langfn/agents/tool_agent.py`
  - `langfn/python/tests/test_tool_agent.py`
  - `langfn/python/tests/test_budgets_retry_http.py`
  - `langfn/python/langfn/core/errors.py`
  - `langfn/python/langfn/core/__init__.py`
  - `langfn/python/langfn/__init__.py`
- Files verified as phase-compatible exports:
  - `langfn/typescript/src/index.ts`
  - `langfn/typescript/src/models/index.ts`
  - `langfn/python/langfn/models/__init__.py`

## Verification summary

- Phase verification steps executed:
  - `npm --prefix langfn/typescript test -- tests/tool-agent.test.ts` — `PASS`
  - `python3 -m pytest langfn/python/tests/test_tool_agent.py langfn/python/tests/test_budgets_retry_http.py -q` — `PASS`
  - `PYTHONPATH=langfn/python python3 -c "from langfn.tools import calculator; assert calculator('2 + 2') == '4'"` — `PASS`
- Extra verification:
  - `npm --prefix langfn/typescript run build` — `PASS`
  - `rg -n "TODO|FIXME|XXX" ...phase scope...` — no matches
- Test execution results:
  - TypeScript: `1` file, `4` tests passed
  - Python: `2` files, `8` tests passed
  - Python emitted pre-existing Pydantic deprecation warnings from `packages/python-core/superfunctions/db/types.py`; they did not affect phase status

## Notes

- The TypeScript built-ins no longer depend on `eval` for calculator execution and now share the same policy semantics as Python for outbound HTTP, secret resolution, search backend requirements, and sandbox gating.
- Anthropic message conversion now preserves assistant `tool_calls` and tool-result `tool_call_id` values when converting transcript history into Anthropic `tool_use` / `tool_result` blocks.
- Tool results in both languages now pass through policy sanitization before the agent records them, which closes the broken tool-calling safety path identified in the audit.
- The TypeScript package build completed cleanly after the tool and provider changes.

## Ready for next phase?

- Yes. The tool substrate, safety policy hooks, and provider/agent round-tripping required by `PHASE_03` are implemented and locally verified.

## Blockers

- None.
