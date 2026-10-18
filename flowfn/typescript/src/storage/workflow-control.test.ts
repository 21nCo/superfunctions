import { it } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { workflowControlContract } from './workflow-control-contract.js';
it('enforces workflow revisions, ownership and concurrent catalogs in memory', async () => {
  await workflowControlContract(new MemoryAdapter());
});
