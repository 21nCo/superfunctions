# @memoryfn/admin

Function-owned MemoryFn administration for Super Console, REST/OpenAPI, SDK,
and MCP projections.

The current public MemoryFn runtime supports only two operator operations:

- `memoryfn.memories.search`
- `memoryfn.memories.ingest`

Both require an environment and namespace. The binding derives the tenant and
mandatory container tag from the authenticated project, environment, namespace,
and region; neither is accepted from request input. Embeddings, metadata,
tenant IDs, and container tags are never returned by the admin service.

```ts
import { memoryfn } from '@memoryfn/core';
import { createMemoryFnDomainAdminAdapter } from '@memoryfn/admin';

// Search is semantic: it needs an embedder. Read the key from the environment.
const memory = memoryfn({
  storage: { kind: 'memory' },
  embedder: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    apiKey: process.env.OPENAI_API_KEY,
  },
});

const adapter = createMemoryFnDomainAdminAdapter({
  projectId: 'project_1',
  memory,
});
```

`memoryfn.memories.search` requires a configured embedder; without one,
MemoryFn rejects the search with `MEMORY_EMBEDDER_REQUIRED` and the operation
fails. Any object implementing `@memoryfn/core`'s `Embedder` interface
(`embed` and `embedBatch`) can instead be passed as the third argument of
`new MemoryFn(config, storage, embedder)`.

Use MemoryFn's Postgres storage for restart-durable production data. The
process-local adapter is intended for zero-infrastructure development and test
deployments.
