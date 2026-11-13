/**
 * Fixture Worker for the FileFn workerd smoke test: a Hono host app that mounts
 * FileFn at /files with `basePath: '/files'`, backed by the in-memory db
 * adapter and an in-memory storage adapter. FileFn is created per request so
 * its `runtime.defer` hook is that request's `ctx.waitUntil`; the adapters live
 * at module scope, so state persists for the isolate's lifetime, which the
 * smoke test relies on across requests. A cron trigger runs session cleanup.
 * The hook is a method that reads `ctx` through `this`, and it counts each
 * `waitUntil` registration so the test can assert lifetime extension directly.
 * A second mount at /expiring issues sessions that expire at once, which the
 * cron test cleans up.
 */
import { Hono } from 'hono';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createFileFn, type FileFnConfig, type FileFnRuntime, type Processor } from '@filefn/server';
import { createMemoryStorage } from './memory-storage.js';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const database = memoryAdapter();
const storage = createMemoryStorage();
let lastCleanup: unknown = null;
let waitUntilRegistrations = 0;

class WaitUntilRuntime implements FileFnRuntime {
  constructor(private readonly ctx: ExecutionContextLike) {}

  defer(work: Promise<unknown>): void {
    this.ctx.waitUntil(work);
    waitUntilRegistrations += 1;
  }
}

const uppercase: Processor = {
  name: 'uppercase',
  supportedMimeTypes: ['text/plain'],
  async process(input, getData) {
    // Yield across timers so the work outlives the response unless it is deferred.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const source = new TextDecoder().decode(await getData());
    return {
      success: true,
      artifacts: [{
        kind: 'uppercase',
        data: new TextEncoder().encode(source.toUpperCase()),
        mimeType: 'text/plain',
        storageKey: `${input.storageKey}.uppercase`,
      }],
    };
  },
};

function fileFnFor(ctx: ExecutionContextLike, mount: { basePath: string; uploadSessionTtlSeconds?: number } = { basePath: '/files' }) {
  const config: FileFnConfig = {
    database,
    storage,
    ...mount,
    namespace: 'smoke',
    policies: [{ name: 'note', contentTypes: ['text/plain'], visibility: 'private' }],
    auth: {
      required: true,
      resolveSession: async (request) => {
        const principalId = request.headers.get('x-smoke-user');
        return principalId ? { principalId, tenantId: 'smoke_tenant' } : null;
      },
    },
    processing: { enabled: true, processors: [uppercase] },
    runtime: new WaitUntilRuntime(ctx),
  };
  return createFileFn(config);
}

const app = new Hono();
app.get('/', (c) => c.text('host app'));
app.all('/files/*', async (c) => {
  const response = await fileFnFor(c.executionCtx).router.handle(c.req.raw);
  return response ?? c.notFound();
});
app.all('/expiring/*', async (c) => {
  const fileFn = fileFnFor(c.executionCtx, { basePath: '/expiring', uploadSessionTtlSeconds: 0 });
  const response = await fileFn.router.handle(c.req.raw);
  return response ?? c.notFound();
});
app.get('/__smoke/last-cleanup', (c) => c.json(lastCleanup));
app.get('/__smoke/wait-until', (c) => c.json({ registrations: waitUntilRegistrations }));

export default {
  fetch: app.fetch,
  async scheduled(_controller: unknown, _env: unknown, ctx: ExecutionContextLike) {
    lastCleanup = await fileFnFor(ctx).cleanupExpiredSessions();
  },
};
