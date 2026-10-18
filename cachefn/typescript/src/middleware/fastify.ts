/** Fastify response caching hooks. */
import type { CacheFn } from '../core/cache.js';
import { eligible, headers, isResponse, key, snapshot } from './http-cache.js';
export interface FastifyPluginOptions { cache: CacheFn; }
export interface FastifyRouteOptions {
  ttl?: number; key?: string | ((req: any) => string); tags?: string[] | ((req: any) => string[]);
  condition?: (req: any) => boolean; vary?: string[];
}
export async function fastify(app: any, options: FastifyPluginOptions) {
  const cache = options.cache;
  if (!cache) throw new Error('Cache instance is required for Fastify plugin');
  app.decorate('cache', cache);
  const requests = new WeakMap<object, { key: string; options: FastifyRouteOptions; hit: boolean }>();
  app.addHook('preHandler', async (request: any, reply: any) => {
    const opts: FastifyRouteOptions | undefined = request.routeOptions?.config?.cachefn;
    const h = headers(request.headers);
    if (!opts || !eligible(request.method, h) || (opts.condition && !opts.condition(request))) return;
    const cacheKey = key(typeof opts.key === 'function' ? opts.key(request) : opts.key ?? request.url, h, opts.vary);
    const state = { key: cacheKey, options: opts, hit: false };
    requests.set(request, state);
    try {
      const cached = await cache.get(cacheKey);
      if (isResponse(cached)) {
        state.hit = true;
        reply.code(cached.status).headers(cached.headers);
        return reply.send(cached.kind === 'bytes' ? Buffer.from(cached.body as number[]) : cached.body);
      }
    } catch { /* Fall through to the route handler. */ }
  });
  app.addHook('onSend', async (request: any, reply: any, payload: any) => {
    const state = requests.get(request);
    if (!state || state.hit || reply.sent || (typeof payload !== 'string' && !Buffer.isBuffer(payload) && payload !== null)) return payload;
    const response = snapshot(reply.statusCode, reply.getHeaders(), Buffer.isBuffer(payload) ? Array.from(payload) : payload, Buffer.isBuffer(payload) ? 'bytes' : 'text', state.options.vary);
    if (response) {
      try {
        const tags = typeof state.options.tags === 'function' ? state.options.tags(request) : state.options.tags;
        await cache.set(state.key, response, { ttl: state.options.ttl, tags });
      } catch { /* Cache failure cannot replace the handler response. */ }
    }
    return payload;
  });
}
