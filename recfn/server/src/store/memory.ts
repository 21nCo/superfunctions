import { memoryAdapter } from '@superfunctions/db/adapters';
import type { RecFnStore } from './types.js';
import { createDbStore } from './db.js';

export function createMemoryStore(): RecFnStore {
  return createDbStore({
    adapter: memoryAdapter({ debug: false }),
    durable: false,
    adapterName: '@superfunctions/db/memory',
  });
}
