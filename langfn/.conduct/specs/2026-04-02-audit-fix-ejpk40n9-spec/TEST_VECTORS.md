# TV-PKG-001

- Description: Package identity and import surface smoke test.
- Input:
  - TypeScript:
    ```bash
    node --input-type=module - <<'EOF'
    import { langfn } from "langfn";
    import { PromptTemplate } from "langfn/prompts";
    import { createLangFnRouter } from "langfn/http";
    import { ReActAgent } from "langfn/agents";
    console.log(typeof langfn, typeof PromptTemplate, typeof createLangFnRouter, typeof ReActAgent);
    EOF
    ```
  - Python:
    ```bash
    python3 - <<'PY'
    from langfn import LangFn
    from langfn.prompts import PromptTemplate, ChatTemplate
    from langfn.observability import Tracer, CostMeter, Budgets
    print(LangFn.__name__, PromptTemplate.__name__, ChatTemplate.__name__, Tracer.__name__, CostMeter.__name__, Budgets.__name__)
    PY
    ```
- Expected output:
  - both commands exit with code `0`
  - all named imports resolve successfully
- Negative variant(s):
  - `import { anything } from "langfn/nonexistent"` MUST fail with module-not-found
  - `from langfn.prompts import MissingThing` MUST raise `ImportError`

# TV-PKG-002

- Description: Version and health metadata consistency check.
- Input:
  - compare:
    - `langfn/typescript/package.json` version
    - `langfn/python/pyproject.toml` version
    - `langfn/python/langfn/__init__.py` `__version__`
    - `/health` HTTP response version
- Expected output:
  - all four version values are exactly equal
- Negative variant(s):
  - if any one source reports a different version, release gate fails with `VERSION_MISMATCH`

# TV-API-001

- Description: Canonical completion response with trace and parsed structured output.
- Input:
  ```json
  {
    "call": "complete",
    "provider": "mock",
    "prompt": "Return JSON {\"sentiment\":\"positive\",\"confidence\":0.9}",
    "structuredSchema": {
      "sentiment": "string",
      "confidence": "number"
    }
  }
  ```
- Expected output:
  ```json
  {
    "content": "{\"sentiment\":\"positive\",\"confidence\":0.9}",
    "traceId": "non-empty string",
    "parsed": {
      "sentiment": "positive",
      "confidence": 0.9
    }
  }
  ```
- Negative variant(s):
  - calling `chat` with `messages: []` MUST fail with `VALIDATION_ERROR`
  - calling `feedback` without `traceId` MUST fail with `VALIDATION_ERROR`

# TV-MODEL-001

- Description: Provider coverage and custom provider SPI smoke test.
- Input:
  ```json
  {
    "providers": ["openai", "anthropic", "ollama", "google", "mistral", "custom"],
    "operation": "complete",
    "prompt": "ping"
  }
  ```
- Expected output:
  - each provider can be constructed through the public surface
  - mock or transport-backed tests for the first-party adapters return canonical completion objects
- Negative variant(s):
  - provider `"bogus"` MUST fail with `UNSUPPORTED_PROVIDER`

# TV-MODEL-002

- Description: Normalized timeout, retry, and ordered batch behavior.
- Input:
  ```json
  {
    "operation": "completeBatch",
    "requests": ["a", "b", "c"],
    "providerBehavior": ["rate_limit_once_then_ok", "timeout", "ok"],
    "retry": {"maxAttempts": 2},
    "partialResults": true
  }
  ```
- Expected output:
  ```json
  [
    {"ok": true, "content": "a"},
    {"ok": false, "error": {"code": "PROVIDER_TIMEOUT"}},
    {"ok": true, "content": "c"}
  ]
  ```
- Negative variant(s):
  - with `partialResults: false`, the first non-retryable failure MUST abort the batch with the canonical error

# TV-PROMPT-001

- Description: Deterministic prompt rendering.
- Input:
  ```json
  {
    "promptTemplate": "Hello {name}",
    "chatTemplate": [{"role": "system", "content": "You are a {role}."}],
    "fewShot": {
      "prefix": "Translate",
      "examples": [{"input": "Hello", "output": "Bonjour"}],
      "suffix": "Input: {input}"
    },
    "values": {"name": "Alice", "role": "helper", "input": "Goodbye"}
  }
  ```
- Expected output:
  ```json
  {
    "prompt": "Hello Alice",
    "chat": [{"role": "system", "content": "You are a helper."}],
    "fewShot": "Translate\n\nInput: Hello\nOutput: Bonjour\n\nInput: Goodbye"
  }
  ```
- Negative variant(s):
  - omitting `name` MUST fail with `VALIDATION_ERROR`

# TV-PROMPT-002

- Description: Prompt registry versioning and deterministic latest resolution.
- Input:
  ```json
  {
    "writes": [
      {"name": "support-reply", "version": "1.0.0"},
      {"name": "support-reply", "version": "1.1.0"}
    ],
    "reads": [
      {"name": "support-reply", "version": "1.0.0"},
      {"name": "support-reply", "version": "latest"}
    ]
  }
  ```
- Expected output:
  - exact read returns `1.0.0`
  - `latest` resolves to `1.1.0`
- Negative variant(s):
  - reading `support-reply@9.9.9` MUST fail with `NOT_FOUND`

# TV-STRUCT-001

- Description: Structured output parse and schema enforcement.
- Input:
  ```json
  {
    "content": "prefix {\"label\":\"bug\",\"severity\":2} suffix",
    "schema": {
      "label": "string",
      "severity": "number"
    }
  }
  ```
- Expected output:
  ```json
  {
    "parsed": {
      "label": "bug",
      "severity": 2
    }
  }
  ```
- Negative variant(s):
  - content without JSON MUST fail with `SCHEMA_VALIDATION`
  - content with `severity: "high"` MUST fail with `SCHEMA_VALIDATION`

# TV-TOOL-001

- Description: Provider-normalized tool-calling round trip.
- Input:
  ```json
  {
    "messages": [{"role": "user", "content": "What is 2 + 3?"}],
    "tools": [
      {
        "name": "add",
        "schema": {
          "type": "object",
          "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
          "required": ["a", "b"]
        }
      }
    ],
    "mockAssistantToolCall": {"id": "call_1", "name": "add", "arguments": {"a": 2, "b": 3}}
  }
  ```
- Expected output:
  ```json
  {
    "finalMessage": "5",
    "historyContains": [
      {"role": "assistant", "toolCalls": [{"id": "call_1"}]},
      {"role": "tool", "toolCallId": "call_1", "content": "5"}
    ]
  }
  ```
- Negative variant(s):
  - invalid tool arguments MUST fail with `TOOL_SCHEMA_ERROR`
  - unknown tool name MUST fail with `TOOL_EXECUTION_ERROR`

# TV-TOOL-002

- Description: Safe built-in tool policy behavior.
- Input:
  ```json
  {
    "calculator": {"expression": "__import__('os').system('rm -rf /')"},
    "apiCall": {"url": "http://169.254.169.254/latest/meta-data"},
    "codeExec": {"code": "print('hi')", "sandboxConfigured": false}
  }
  ```
- Expected output:
  ```json
  {
    "calculator": {"error": {"code": "TOOL_POLICY_VIOLATION"}},
    "apiCall": {"error": {"code": "TOOL_POLICY_VIOLATION"}},
    "codeExec": {"error": {"code": "TOOL_DISABLED"}}
  }
  ```
- Negative variant(s):
  - these failures are the required negative cases; successful paths require an approved parser, allowlist, or sandbox executor

# TV-ORCH-001

- Description: Sequential, parallel, map-reduce, and router orchestration.
- Input:
  ```json
  {
    "sequentialInput": 3,
    "parallelInput": 3,
    "mapReduceInput": ["a", "b"],
    "routerInput": "support ticket"
  }
  ```
- Expected output:
  ```json
  {
    "sequential": 8,
    "parallel": [4, 6],
    "mapReduce": "A|B",
    "router": "support"
  }
  ```
- Negative variant(s):
  - router returning `"unknown"` MUST fail with `VALIDATION_ERROR`

# TV-GRAPH-001

- Description: Conditional graph execution with checkpoint and max-step enforcement.
- Input:
  ```json
  {
    "initialState": {"count": 0},
    "nodes": ["increment", "decide", "end"],
    "maxSteps": 3
  }
  ```
- Expected output:
  ```json
  {
    "finalState": {"count": 1},
    "checkpointSaved": true
  }
  ```
- Negative variant(s):
  - a graph that never reaches `end` within `maxSteps` MUST fail with `GRAPH_MAX_STEPS`

# TV-AGENT-001

- Description: ToolAgent and ReActAgent transcript preservation.
- Input:
  ```json
  {
    "agent": "react",
    "userPrompt": "What is 2 + 3?",
    "tool": "add"
  }
  ```
- Expected output:
  ```json
  {
    "output": "5",
    "messagesContainToolTurn": true
  }
  ```
- Negative variant(s):
  - exceeding the configured iteration limit MUST fail with `TOOL_EXECUTION_ERROR` or `AGENT_MAX_ITERATIONS`

# TV-AGENT-002

- Description: PlanExecute and multi-agent coordinator behavior.
- Input:
  ```json
  {
    "planExecuteGoal": "Summarize two documents and compare them",
    "multiAgentTask": "Research then draft"
  }
  ```
- Expected output:
  ```json
  {
    "plan": ["summarize doc 1", "summarize doc 2", "compare summaries"],
    "finalOutput": "non-empty string",
    "coordinatorDecisions": ["researcher", "writer"]
  }
  ```
- Negative variant(s):
  - a planner that returns an empty plan MUST fail with `VALIDATION_ERROR`

# TV-MEM-001

- Description: Buffer and summary memory cap behavior.
- Input:
  ```json
  {
    "bufferMaxMessages": 2,
    "messages": [
      {"role": "user", "content": "one"},
      {"role": "assistant", "content": "two"},
      {"role": "user", "content": "three"}
    ]
  }
  ```
- Expected output:
  ```json
  {
    "buffer": [
      {"role": "assistant", "content": "two"},
      {"role": "user", "content": "three"}
    ],
    "summaryInsertedWhenCapExceeded": true
  }
  ```
- Negative variant(s):
  - requesting a negative memory cap MUST fail with `VALIDATION_ERROR`

# TV-RAG-001

- Description: Retriever-centric RAG with memoryfn-backed durable path.
- Input:
  ```json
  {
    "retriever": "memoryfnAdapter",
    "query": "Tell me about Paris",
    "documents": [
      {"content": "Paris is the capital of France.", "metadata": {"source": "wiki"}}
    ]
  }
  ```
- Expected output:
  ```json
  {
    "retrieved": [
      {"content": "Paris is the capital of France.", "metadata": {"source": "wiki"}}
    ],
    "answerContains": "capital of France"
  }
  ```
- Negative variant(s):
  - production durable mode backed by a full-table reranking reference store MUST fail the release gate with `NON_PRODUCTION_BACKEND`

# TV-STREAM-001

- Description: Unified stream event taxonomy and terminal behavior.
- Input:
  ```json
  {
    "streamedEvents": [
      {"type": "content", "delta": "Hel"},
      {"type": "content", "delta": "lo"},
      {"type": "tool_call", "toolName": "lookup_weather"},
      {"type": "tool_result", "toolCallId": "call_1"},
      {"type": "token_usage", "promptTokens": 3, "completionTokens": 2},
      {"type": "end"}
    ]
  }
  ```
- Expected output:
  - all events include the same `traceId`
  - `end` is the final event
- Negative variant(s):
  - any event emitted after `end` MUST fail the stream-normalization tests
  - timeout or cancellation MUST terminate with canonical error behavior

# TV-OBS-001

- Description: Per-invocation trace creation, persistence, query, and feedback.
- Input:
  ```json
  {
    "invocations": ["complete:one", "complete:two"],
    "feedback": {"traceId": "second-trace", "rating": 5}
  }
  ```
- Expected output:
  ```json
  {
    "traceIdsAreDistinct": true,
    "queriedTraceCount": 2,
    "feedbackStored": true
  }
  ```
- Negative variant(s):
  - feedback against an unknown trace MUST fail with `TRACE_NOT_FOUND`

# TV-OBS-002

- Description: Cost, budget, redaction, and watchfn export behavior.
- Input:
  ```json
  {
    "promptTokens": 1000,
    "completionTokens": 500,
    "budgetUsd": 0.5,
    "metadata": {"apiKey": "secret", "email": "user@example.com"}
  }
  ```
- Expected output:
  ```json
  {
    "cost": {"total": "computed"},
    "redactedMetadata": {"apiKey": "***REDACTED***", "email": "***REDACTED***"}
  }
  ```
- Negative variant(s):
  - if computed cost exceeds budget, the call MUST fail with `BUDGET_EXCEEDED`

# TV-HTTP-001

- Description: Canonical HTTP success envelopes.
- Input:
  ```json
  {
    "request": {
      "method": "POST",
      "path": "/complete",
      "body": {"prompt": "Hello"}
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "traceId": "non-empty string",
    "data": {"content": "Hello"},
    "error": null
  }
  ```
- Negative variant(s):
  - `POST /stream` with invalid body MUST fail with `VALIDATION_ERROR`

# TV-HTTP-002

- Description: Auth, tenant headers, and rate limiting.
- Input:
  ```json
  {
    "method": "POST",
    "path": "/chat",
    "headers": {
      "authorization": "Bearer valid",
      "x-tenant-id": "tenant_123",
      "x-user-id": "user_456"
    },
    "body": {"messages": [{"role": "user", "content": "Hi"}]}
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "traceMetadata": {"tenantId": "tenant_123", "userId": "user_456"}
  }
  ```
- Negative variant(s):
  - missing auth on an authenticated route MUST fail with `AUTH_REQUIRED`
  - exceeding the configured rate limit MUST fail with `RATE_LIMITED`

# TV-MCP-001

- Description: MCP list-tools and call-tool round trip over stdio and SSE.
- Input:
  ```json
  {
    "transport": "stdio",
    "tools": [{"name": "add"}],
    "request": {"method": "tools/call", "params": {"name": "add", "arguments": {"a": 2, "b": 3}}}
  }
  ```
- Expected output:
  ```json
  {
    "result": 5
  }
  ```
- Negative variant(s):
  - unknown method MUST fail with `MCP_PROTOCOL_ERROR`
  - transport shutdown hang MUST fail the integration test with `MCP_TRANSPORT_ERROR`

# TV-EVAL-001

- Description: Evaluation compare and testfn export.
- Input:
  ```json
  {
    "dataset": [
      {"input": "2+2", "expected": "4"},
      {"input": "capital of France", "expected": "Paris"}
    ],
    "models": ["mockA", "mockB"]
  }
  ```
- Expected output:
  ```json
  {
    "accuracy": "computed",
    "perModel": {"mockA": {}, "mockB": {}},
    "testfnExported": true
  }
  ```
- Negative variant(s):
  - an empty dataset MUST fail with `VALIDATION_ERROR`

# TV-PERF-001

- Description: Stable cache keys, pooling, and ordered batch behavior.
- Input:
  ```json
  {
    "requests": [
      {"prompt": "Capital of France?", "metadata": {"b": 2, "a": 1}},
      {"prompt": "Capital of France?", "metadata": {"a": 1, "b": 2}}
    ]
  }
  ```
- Expected output:
  - both requests map to the same cache key
  - repeated invocation reuses pooled transport/cache path
  - ordered batch results preserve request order
- Negative variant(s):
  - logically equivalent metadata producing different cache keys MUST fail the cache determinism test

# TV-SEC-001

- Description: Secret lookup, redaction, and output sanitization.
- Input:
  ```json
  {
    "providerSecretRef": "OPENAI_API_KEY",
    "traceMetadata": {"authorization": "Bearer secret", "ssn": "111-22-3333"},
    "toolOutput": "<script>alert(1)</script>"
  }
  ```
- Expected output:
  ```json
  {
    "secretResolvedVia": "secfn or configured secret provider",
    "redactedTraceMetadata": {"authorization": "***REDACTED***", "ssn": "***REDACTED***"},
    "sanitizedOutput": "safe string"
  }
  ```
- Negative variant(s):
  - a missing required secret MUST fail with `NOT_CONFIGURED`

# TV-QUAL-001

- Description: Repo-root release gate.
- Input:
  ```bash
  npm --prefix langfn/typescript run build
  npm --prefix langfn/typescript run test
  python3 -m pytest langfn/python/tests -q
  ```
- Expected output:
  - all commands exit with code `0`
  - release gate reports success for imports, providers, HTTP, MCP, and parity checks
- Negative variant(s):
  - any import/export drift or failing suite MUST fail the release gate

# TV-ENG-001

- Description: Shared superfunctions usage and duplication gate.
- Input:
  ```bash
  npx jscpd langfn --min-lines 10 --min-tokens 50 --reporters console
  rg -n "@superfunctions/|superfunctions\\." langfn/typescript langfn/python
  ```
- Expected output:
  - duplication report remains at or below the agreed threshold set by the release gate
  - DB, HTTP, auth, secrets, and testing integrations are implemented through shared packages where applicable
- Negative variant(s):
  - a new bespoke auth/router/DB implementation where a shared superfunctions abstraction exists MUST fail architecture review
