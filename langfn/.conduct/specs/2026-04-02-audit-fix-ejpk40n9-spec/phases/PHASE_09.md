# Phase goal

Deliver the performance, scalability, duplication-reduction, and shared-package reuse work required to make LangFn operationally safe in production.

# In scope

- Provider transport pooling and connection reuse.
- Cache key normalization and cachefn-compatible caching hooks.
- Scalable retrieval batching, pagination, and concurrency controls.
- Internal duplication reduction and shared superfunctions package adoption.

# Out of scope

- Public README walkthroughs and final release-gate authoring.
- New user-facing capabilities outside the production-hardening scope already specified.

# Deliverables

- `langfn/typescript/src/models/transport.ts`
- `langfn/typescript/src/models/openai.ts`
- `langfn/typescript/src/models/anthropic.ts`
- `langfn/typescript/src/models/ollama.ts`
- `langfn/typescript/src/storage/cache.ts`
- `langfn/typescript/src/rag/db-vector-store.ts`
- `langfn/typescript/src/tools/api_call.ts`
- `langfn/typescript/src/utils/cache-keys.ts`
- `langfn/typescript/src/utils/concurrency.ts`
- `langfn/typescript/tests/performance.test.ts`
- `langfn/python/langfn/models/transport.py`
- `langfn/python/langfn/models/openai.py`
- `langfn/python/langfn/models/anthropic.py`
- `langfn/python/langfn/models/ollama.py`
- `langfn/python/langfn/storage/cache.py`
- `langfn/python/langfn/rag/db_vector_store.py`
- `langfn/python/langfn/tools/api_call.py`
- `langfn/python/langfn/utils/cache_keys.py`
- `langfn/python/langfn/utils/concurrency.py`
- `langfn/python/tests/test_performance_and_scaling.py`
- `scripts/check-duplication.mjs`

# Requirements covered

- `PERF-001`
- `ENG-001`
- `SEC-001`

# Implementation tasks

1. Centralize provider transport reuse in shared per-language helpers and route all first-party adapters through them.
2. Define canonical cache-key derivation for completions, chat, embeddings, and retriever requests and expose cachefn-compatible hook points.
3. Add bounded concurrency controls for batch/model calls and RAG retrieval while preserving input/result ordering.
4. Replace production retrieval hot spots that page only 100 rows or rerank full tables in application code with indexed/delegated retrieval paths.
5. Extract duplicated provider, retrieval, and agent-control utilities into shared language-local helpers instead of repeating logic per backend.
6. Replace bespoke infrastructure with shared superfunctions packages where available, including `@superfunctions/http`, `@superfunctions/db`, auth hooks, `secfn`, `cachefn`, `memoryfn`, and `testfn` integration points.
7. Tighten the duplication gate or report so LangFn stays below the agreed duplication threshold documented in `ENG-001`.
8. Add performance/scalability tests that cover transport reuse, cache-key stability, bounded concurrency, scalable retrieval, and duplication reporting.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/performance.test.ts`.
   Expected outcome: the TypeScript performance/scalability suite passes, including transport reuse and stable cache-key coverage.
2. Run `python3 -m pytest langfn/python/tests/test_performance_and_scaling.py -q`.
   Expected outcome: the Python performance/scalability suite passes with bounded concurrency and retrieval assertions.
3. Run `npx jscpd langfn --min-lines 10 --min-tokens 50 --reporters console`.
   Expected outcome: the duplication report completes successfully and stays within the threshold recorded for `ENG-001`.

# Stop condition

- Stop after provider and retrieval hot paths reuse shared helpers, cachefn/memoryfn/secfn integration points exist, duplication is reduced and gated, and all verification commands pass.
