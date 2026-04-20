# PHASE_01 Completion Report

- Spec bundle: `langfn/.conduct/specs/2026-04-02-audit-fix-ejpk40n9-spec`
- Phase: `PHASE_01`
- Date: `2026-04-02`
- Status: `PASS`

## Scope completed

This phase stabilized the LangFn client/provider substrate in both languages around the canonical request, error, retry, timeout, cancellation, and transport contract required by `API-001`, `MODEL-001`, `MODEL-002`, and `ENG-001`.

## Implemented

### Python

- Reworked `langfn/python/langfn/client.py` into the canonical client surface:
  - optional model at construction time
  - `with_model(...)` first-party/custom provider factory
  - per-call trace IDs instead of instance-global traces
  - ordered `complete_batch(...)` with explicit partial-failure results
  - normalized validation, timeout, and cancellation handling
  - `feedback(...)` and `get_traces(...)` parity helpers
  - retained embedding support via OpenAI embeddings auto-wiring
- Completed the provider/error substrate:
  - canonical error classes in `langfn/python/langfn/core/errors.py`
  - canonical request/response and batch/event types in `langfn/python/langfn/core/types.py`
  - reusable transport helper in `langfn/python/langfn/models/transport.py`
  - provider adapters for OpenAI, Anthropic, Ollama, Google, Mistral, Mock, and Custom
  - retry helper updated to the canonical provider timeout/rate-limit codes
- Added/expanded deterministic provider-client tests in:
  - `langfn/python/tests/test_openai_provider.py`
  - `langfn/python/tests/test_langfn_basic.py`

### TypeScript

- Reworked `langfn/typescript/src/client.ts` into the canonical client surface:
  - `withModel(...)` first-party/custom provider factory
  - normalized completion/chat/stream/batch/feedback/traces behavior
  - ordered partial batch results with preserved canonical error instances
  - timeout and cancellation controls
  - trace attachment and optional cost/parsed fields
- Added the missing substrate pieces:
  - `langfn/typescript/src/core/errors.ts`
  - rewritten `langfn/typescript/src/core/types.ts`
  - reusable transport helper in `langfn/typescript/src/models/transport.ts`
  - first-party Google and Mistral adapters
  - upgraded OpenAI, Anthropic, Ollama, Mock, and Custom provider handling
  - retry/cancellation utilities in `langfn/typescript/src/utils/retry.ts` and `langfn/typescript/src/utils/cancel.ts`
- Added deterministic provider-client coverage in `langfn/typescript/tests/provider-client.test.ts`
- Adjusted `langfn/typescript/src/observability/cost-meter.ts` to the new canonical cost shape (`input` / `output` / `total`)

## Verification

### Required phase checks

1. `npm --prefix langfn/typescript test -- tests/provider-client.test.ts`
   - Result: `PASS` (`1` file, `5` tests)
2. `python3 -m pytest langfn/python/tests/test_openai_provider.py langfn/python/tests/test_langfn_basic.py -q`
   - Result: `PASS` (`11` tests)
3. `PYTHONPATH=langfn/python python3 -c "from langfn import LangFn; lf = LangFn().with_model('openai', model='gpt-4o-mini'); assert hasattr(lf, 'complete_batch') and hasattr(lf, 'get_traces')"`
   - Result: `PASS`

### Extra verification

- `npm --prefix langfn/typescript run build`
  - Result: `PASS`
  - Note: build emitted the pre-existing `eval` bundler warning from `src/tools/calculator.ts`, but the package built successfully.
- `python3 -m py_compile` was used during implementation to catch syntax regressions in the rewritten Python client/provider files.

## Notable decisions

- Python import-time dependencies on shared `superfunctions` packages were kept lazy where necessary so the required `PYTHONPATH=langfn/python ...` smoke command succeeds without forcing the shared namespace package onto the import path.
- TypeScript batch failure handling now preserves the original canonical error instance when `partialResults` is disabled instead of wrapping it into a generic error with only the same code.
- The new TypeScript provider/client tests avoid runtime dependency on `zod`, which keeps the targeted suite runnable in the current workspace while still verifying structured-output parsing semantics through the generic parser contract.

## Files materially delivered for this phase

- `langfn/python/langfn/client.py`
- `langfn/python/langfn/core/errors.py`
- `langfn/python/langfn/core/types.py`
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

## Completion statement

`PHASE_01` is complete. The first-party providers are now constructible through the public API in both languages, transport reuse is centralized, retries/timeouts/cancellation are normalized, and the required verification suite passes.
