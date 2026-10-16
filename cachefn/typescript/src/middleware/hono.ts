/** Hono response caching. */
import type { CacheFn } from '../core/cache.js';
import { eligible, headers, isResponse, key, snapshot } from './http-cache.js';
export interface HonoMiddlewareOptions {
  cache?: CacheFn; ttl?: number; key?: string | ((c: any) => string);
  tags?: string[] | ((c: any) => string[]); condition?: (c: any) => boolean; vary?: string[];
}
export function hono(options: HonoMiddlewareOptions = {}) {
  const cache = options.cache;
  if (!cache) throw new Error('Cache instance is required for Hono middleware');
  return async (c: any, next: any) => {
    const h = headers(c.req.raw.headers);
    if (!eligible(c.req.method, h) || (options.condition && !options.condition(c))) return next();
    const cacheKey = key(typeof options.key === 'function' ? options.key(c) : options.key ?? c.req.url, h, options.vary);
    try {
      const cached = await cache.get(cacheKey);
      if (isResponse(cached)) {
        c.res = new Response([204, 205].includes(cached.status) ? null : new Uint8Array(cached.body as number[]), { status: cached.status, headers: cached.headers });
        return;
      }
    } catch { /* Fall through to the origin. */ }
    await next();
    // Event streams are never cacheable; other bodies are bounded below.
    if (/text\/event-stream/i.test(c.res.headers.get('content-type') ?? '')) return;
    const response = snapshot(c.res.status, c.res.headers, null, 'bytes', options.vary);
    if (!response) return;
    try {
      const reader = c.res.clone().body?.getReader();
      const bytes: number[] = [];
      if (reader) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cache body timeout')), 1000); });
        try {
          while (true) {
            const part = await Promise.race([reader.read(), deadline]);
            if (part.done) break;
            if (bytes.length + part.value.length > 1024 * 1024) throw new Error('Cache body exceeds 1 MiB');
            for (const byte of part.value) bytes.push(byte);
          }
        } finally {
          clearTimeout(timer);
          void reader.cancel().catch(() => {});
        }
      }
      response.body = bytes;
      const tags = typeof options.tags === 'function' ? options.tags(c) : options.tags;
      await cache.set(cacheKey, response, { ttl: options.ttl, tags });
    } catch { /* Preserve the handler response when cache storage fails. */ }
  };
}
