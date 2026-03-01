import {
  createRecFnServer,
  createMemoryStore,
  MemoryStorageAdapter,
} from '../src/index.js';
import type { AuthResult } from '../src/middleware/auth.js';

const API_KEYS: Record<string, AuthResult> = {
  'sk-valid-key': { namespace: 'ns_test', apiKey: 'sk-valid-key' },
  'sk-ns-a': { namespace: 'ns_a', apiKey: 'sk-ns-a' },
  'sk-ns-b': { namespace: 'ns_b', apiKey: 'sk-ns-b' },
};

export function createTestServer() {
  const store = createMemoryStore();
  const storage = new MemoryStorageAdapter();
  const server = createRecFnServer({
    store,
    storage,
    validateApiKey: (key: string) => API_KEYS[key] ?? null,
  });
  return { server, store, storage };
}

export function req(
  method: string,
  path: string,
  opts?: { body?: unknown; apiKey?: string },
): Request {
  const headers: Record<string, string> = {};
  if (opts?.apiKey !== undefined) {
    if (opts.apiKey !== '') {
      headers['Authorization'] = `Bearer ${opts.apiKey}`;
    }
  } else {
    headers['Authorization'] = 'Bearer sk-valid-key';
  }
  if (opts?.body) {
    headers['Content-Type'] = 'application/json';
  }
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

export async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}
