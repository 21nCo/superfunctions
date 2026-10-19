---
title: Memory and RAG
description: Choose in-process memory or injected retrieval adapters.
---

`langfn/memory` exports buffer and summary memory helpers. `langfn/rag` exports base retrieval contracts, OpenAI embedding support, in-memory and DB vector-store adapters, and a MemoryFn bridge. Select storage according to your durability and authorization requirements; an in-memory helper is process-local.

`DbVectorStore` defaults to `mode: "reference"`, an application-side scan that pages through at most `maxScan` (512) rows and reranks them in process. That default is not a production retrieval backend. For production use, construct it with `mode: "production"` and an `indexedSearch` callback backed by adapter-native vector search, or use the MemoryFn bridge; in production mode a store without `indexedSearch` throws `NonProductionBackendError` on search.

The first-party provider matrix lists OpenAI as the embeddings adapter for this release line. The bridge calls an injected `search(query, { k, filter })` or `retrieve(query, options)` interface; it does not directly implement MemoryFn’s `{ q, tenantId, containerTags }` search contract. Supply a host adapter that maps the query/options, injects trusted tenant and container-tag scope, and converts results to LangFn documents. The bridge itself neither passes nor enforces that authorization scope. Keep application authorization and deletion state at the host boundary, and do not treat retrieval tags as membership authority.

Inspect [memory exports](https://github.com/21nCo/super-functions/blob/dev/langfn/typescript/src/memory/index.ts) and [RAG exports](https://github.com/21nCo/super-functions/blob/dev/langfn/typescript/src/rag/index.ts) before selecting an adapter. The current source does not expose a shared `getSchema` CLI discovery contract; hosts provision adapter tables explicitly.
