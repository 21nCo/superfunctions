# Phase goal

Finish LangFn memory and retriever-centric RAG so ephemeral memory remains in LangFn while durable production retrieval integrates cleanly through `memoryfn` or indexed adapters.

# In scope

- BufferMemory and SummaryMemory semantics.
- Retriever and vector-store public interfaces.
- Reference vector stores versus production retrieval boundary.
- `memoryfn` adapter path and scalable retriever behavior.

# Out of scope

- Streaming/trace export behavior.
- HTTP route exposure and auth/rate limiting.

# Deliverables

- `langfn/typescript/src/memory/buffer.ts`
- `langfn/typescript/src/memory/summary.ts`
- `langfn/typescript/src/memory/index.ts`
- `langfn/typescript/src/rag/base.ts`
- `langfn/typescript/src/rag/memory.ts`
- `langfn/typescript/src/rag/openai.ts`
- `langfn/typescript/src/rag/db-vector-store.ts`
- `langfn/typescript/src/rag/memoryfn.ts`
- `langfn/typescript/src/rag/index.ts`
- `langfn/typescript/tests/memory-rag.test.ts`
- `langfn/python/langfn/memory/buffer.py`
- `langfn/python/langfn/memory/summary.py`
- `langfn/python/langfn/memory/__init__.py`
- `langfn/python/langfn/rag/base.py`
- `langfn/python/langfn/rag/memory.py`
- `langfn/python/langfn/rag/openai.py`
- `langfn/python/langfn/rag/db_vector_store.py`
- `langfn/python/langfn/rag/memoryfn.py`
- `langfn/python/langfn/rag/__init__.py`
- `langfn/python/tests/test_memory_and_rag.py`

# Requirements covered

- `MEM-001`
- `RAG-001`

# Implementation tasks

1. Implement BufferMemory retention caps and SummaryMemory replacement behavior with deterministic ordering in both languages.
2. Expose canonical `Retriever`, `VectorStore`, and RAG chain surfaces from both public APIs.
3. Clearly mark in-memory and reference DB vector stores as non-production backends in code comments, docs, and type names where needed.
4. Replace application-side full-table reranking for production paths with indexed retrieval or delegated retrieval adapters.
5. Add a first-class `memoryfn` retriever adapter surface and tests for its integration path.
6. Ensure retriever metadata filters, result ordering, and top-k behavior are deterministic and explicit.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/memory-rag.test.ts`.
   Expected outcome: TypeScript memory and RAG tests pass, including `memoryfn` adapter coverage.
2. Run `python3 -m pytest langfn/python/tests/test_memory_and_rag.py -q`.
   Expected outcome: Python memory and RAG tests pass, including deterministic memory rollover and retriever behavior.

# Stop condition

- Stop after LangFn owns only ephemeral memory plus retriever orchestration, production retrieval no longer depends on full-table reranking, and the memory/RAG verification suites pass.
