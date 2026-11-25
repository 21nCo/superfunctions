import {
  createCapabilityAdminClient,
  type AdminClient,
  type AdminClientRequestOptions,
} from '@superfunctions/admin';
import { memoryFnAdminCapability } from './capability.js';
import type {
  MemoryFnIngestMemoryInput,
  MemoryFnSearchMemoriesInput,
} from './types.js';

/** Function-scoped TypeScript client with exact MemoryFn methods. */
export function createMemoryFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(memoryFnAdminCapability, adminClient);
  return Object.assign(client, {
    memories: {
      search: (
        input: MemoryFnSearchMemoriesInput,
        options?: AdminClientRequestOptions,
      ) => client.invoke('memoryfn.memories.search', input, options),
      ingest: (
        input: MemoryFnIngestMemoryInput,
        options?: AdminClientRequestOptions,
      ) => client.invoke('memoryfn.memories.ingest', input, options),
    },
  });
}
