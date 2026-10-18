import { it } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { workflowControlContract } from './workflow-control-contract.js';
import { schedulerContract } from './scheduler-contract.js';
it('shares durable schedule ownership and preserves attempts across restart', async () => { await schedulerContract(new MemoryAdapter()); });
it('enforces workflow revisions, ownership and concurrent catalogs in memory', async () => {
  await workflowControlContract(new MemoryAdapter());
});
