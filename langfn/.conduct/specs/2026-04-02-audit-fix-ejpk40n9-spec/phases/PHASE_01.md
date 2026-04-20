# Phase goal

Stabilize the cross-language LangFn client and provider substrate so every first-party model adapter uses the canonical request, error, retry, timeout, and transport lifecycle semantics.

# In scope

- Public client method parity for completion, chat, streaming, embedding, batching, traces, and feedback.
- Provider SPI and first-party adapters for OpenAI, Anthropic, Ollama, Google, Mistral, and custom providers.
- Canonical error normalization, retries, timeouts, cancellation, and partial batch failure handling.
- Shared transport helper extraction per language.

# Out of scope

- Prompt registries, structured parsing, agent loops, and HTTP route exposure.
- Built-in tool safety policy enforcement beyond the provider transport boundary.

# Deliverables

- `langfn/typescript/src/client.ts`
- `langfn/typescript/src/core/types.ts`
- `langfn/typescript/src/core/errors.ts`
- `langfn/typescript/src/models/base.ts`
- `langfn/typescript/src/models/index.ts`
- `langfn/typescript/src/models/openai.ts`
- `langfn/typescript/src/models/anthropic.ts`
- `langfn/typescript/src/models/ollama.ts`
- `langfn/typescript/src/models/google.ts`
- `langfn/typescript/src/models/mistral.ts`
- `langfn/typescript/src/models/mock.ts`
- `langfn/typescript/src/models/transport.ts`
- `langfn/typescript/src/utils/retry.ts`
- `langfn/typescript/src/utils/cancel.ts`
- `langfn/typescript/src/utils/index.ts`
- `langfn/typescript/tests/provider-client.test.ts`
- `langfn/python/langfn/client.py`
- `langfn/python/langfn/core/types.py`
- `langfn/python/langfn/core/errors.py`
- `langfn/python/langfn/models/base.py`
- `langfn/python/langfn/models/__init__.py`
- `langfn/python/langfn/models/openai.py`
- `langfn/python/langfn/models/anthropic.py`
- `langfn/python/langfn/models/ollama.py`
- `langfn/python/langfn/models/google.py`
- `langfn/python/langfn/models/mistral.py`
- `langfn/python/langfn/models/mock.py`
- `langfn/python/langfn/models/transport.py`
- `langfn/python/langfn/utils/retry.py`
- `langfn/python/langfn/utils/cancel.py`
- `langfn/python/langfn/utils/__init__.py`
- `langfn/python/tests/test_openai_provider.py`
- `langfn/python/tests/test_langfn_basic.py`

# Requirements covered

- `API-001`
- `MODEL-001`
- `MODEL-002`
- `ENG-001`

# Implementation tasks

1. Define the canonical request/response types and error code helpers in both languages and route all provider code through them.
2. Add missing first-party provider adapters for Google and Mistral and expose them through the public factory surface.
3. Extract shared transport lifecycle helpers so OpenAI, Anthropic, Ollama, Google, and Mistral reuse pooled clients rather than per-call transports.
4. Normalize provider failures into canonical auth, rate-limit, timeout, abort, and internal errors with retry metadata where available.
5. Implement bounded retries, timeout controls, and cancellation propagation in the shared client path.
6. Make `completeBatch` preserve input order and explicit partial-failure semantics in both languages.
7. Add deterministic provider/client tests that cover provider selection, retry behavior, timeout behavior, cancellation, and partial batch failures.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/provider-client.test.ts`.
   Expected outcome: the TypeScript client/provider suite passes for all first-party adapters and the custom SPI.
2. Run `python3 -m pytest langfn/python/tests/test_openai_provider.py langfn/python/tests/test_langfn_basic.py -q`.
   Expected outcome: the Python provider/client suite passes, including normalized error and retry behavior.
3. Run `PYTHONPATH=langfn/python python3 -c "from langfn import LangFn; lf = LangFn().with_model('openai', model='gpt-4o-mini'); assert hasattr(lf, 'complete_batch') and hasattr(lf, 'get_traces')"`.
   Expected outcome: the public Python API exposes the parity methods required by `API-001`.

# Stop condition

- Stop after all first-party providers are constructible through the public API, provider failures normalize correctly, transport reuse is centralized, and the verification suites pass.
