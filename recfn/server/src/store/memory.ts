import { memoryAdapter } from '@superfunctions/db/adapters';
import type { RecFnStore } from './types.js';
import { createDbStore } from './db.js';

export function createMemoryStore(options: { maxConcurrentBots?: number } = {}): RecFnStore {
  return createDbStore({
    maxConcurrentBots: options.maxConcurrentBots,
    adapter: memoryAdapter({ debug: false }),
    durable: false,
    adapterName: '@superfunctions/db/memory',
  });
}
