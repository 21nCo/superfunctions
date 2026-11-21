// Compiled by `npm run typecheck` (tsconfig.types.json), never run. It fails to
// compile if an add/search-only IMemoryFn stops being accepted by the HTTP
// router or the MCP server, if MemoryFn stops implementing the document methods,
// or if MemoryFn stops accepting a StorageAdapter without replaceSourceIfChanged.
import type { IMemoryFn } from '../../src/core/config';
import { MemoryFn } from '../../src/core/pipeline';
import type { StorageAdapter } from '../../src/storage/adapter';
import { createMemoryRouter } from '../../src/http/router';
import { MemoryMCP } from '../../src/mcp/server';

const legacy: IMemoryFn = {
  add: async () => ({ memories: [], relationships: [], summary: { created: 0, updated: 0, deduplicated: 0 } }),
  search: async () => ({ results: [], metadata: { totalFound: 0, returned: 0 } }),
};

export const router = createMemoryRouter(legacy, { authorize: async () => null });
export const mcp = new MemoryMCP(legacy, { tenantId: 'tenant-a', containerTags: [] });

declare const full: MemoryFn;
export const documents: Required<Pick<IMemoryFn, 'upsertDocument' | 'forgetBySource'>> = full;

// The PR base's StorageAdapter shape, without the document capability.
declare const baseAdapter: Omit<StorageAdapter, 'replaceSourceIfChanged'>;
export const ordinary = new MemoryFn({ storage: { kind: 'memory' } }, baseAdapter);
