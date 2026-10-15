/** Express JSON response caching. */
import type { CacheFn } from '../core/cache.js';
import { eligible, headers, isResponse, key, snapshot } from './http-cache.js';
export interface ExpressMiddlewareOptions {
  cache?: CacheFn; ttl?: number; key?: string | ((req: any) => string);
  tags?: string[] | ((req: any) => string[]); condition?: (req: any) => boolean; vary?: string[];
}
export function middleware(options: ExpressMiddlewareOptions = {}) {
  const cache = options.cache;
  if (!cache) throw new Error('Cache instance is required for Express middleware');
  return async (req: any, res: any, next: any) => {
    const h = headers(req.headers);
    if (!eligible(req.method, h) || (options.condition && !options.condition(req))) return next();
    const cacheKey = key(typeof options.key === 'function' ? options.key(req) : options.key ?? req.originalUrl ?? req.url, h, options.vary);
    try {
      const cached = await cache.get(cacheKey);
      if (isResponse(cached)) {
        res.status(cached.status);
        for (const [name, value] of Object.entries(cached.headers)) res.setHeader(name, value);
        return cached.kind === 'text' ? res.send(cached.body) : res.json(cached.body);
      }
    } catch { /* Cache failures must not prevent serving the origin response. */ }
    const originalJson = res.json.bind(res);
    res.json = (data: any) => {
      // Express sets JSON content type during json(); collect headers afterward.
      const send = res.send;
      let wire: unknown;
      if (typeof send === 'function') res.send = function(body: unknown) { wire = body; return send.call(this, body); };
      let result: any;
      try { result = originalJson(data); } finally { if (typeof send === 'function') res.send = send; }
      const body = typeof wire === 'string' ? wire : data;
      const response = body === undefined ? undefined : snapshot(res.statusCode, res.getHeaders(), body, typeof wire === 'string' ? 'text' : 'json', options.vary);
      if (response) {
        try {
          const tags = typeof options.tags === 'function' ? options.tags(req) : options.tags;
          void cache.set(cacheKey, response, { ttl: options.ttl, tags }).catch(() => {});
        } catch { /* Origin response has already been sent. */ }
      }
      return result;
    };
    return next();
  };
}
