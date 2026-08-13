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
import { MemoryFn, MemoryStorageAdapter } from '@memoryfn/core';
import { createMemoryFnDomainAdminAdapter } from '@memoryfn/admin';

const storage = new MemoryStorageAdapter();
const memory = new MemoryFn({ storage: { kind: 'sqlite' } }, storage);

const adapter = createMemoryFnDomainAdminAdapter({
  projectId: 'project_1',
  memory,
});
```

Use MemoryFn's Postgres storage for restart-durable production data. The
process-local adapter is intended for zero-infrastructure development and test
deployments.
