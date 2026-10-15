import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { CacheFn, cacheFn, memoize, expressMiddleware, honoMiddleware, fastifyPlugin } from '../src/index.js';
describe('V0 factory convenience', () => {
  it('preserves recursive sync return types and exposes attached clearing', async () => {
    const fibonacci: ((n: number) => number) = cacheFn.memoize((n: number): number => n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2));
    expect(fibonacci(20)).toBe(6765);
    const source = vi.fn((n: number) => n + 1); const cached = cacheFn.memoize(source);
    expect(cached(1)).toBe(2); expect(cached(1)).toBe(2); expect(source).toHaveBeenCalledTimes(1);
    await cacheFn.memoize.clear(cached); cached(1); expect(source).toHaveBeenCalledTimes(2);
  });
  it('handles ordinary Promise-returning functions, shares pending work and retries rejection', async () => {
    let reject = true;
    const source = vi.fn(() => reject ? Promise.reject(new Error('retry')) : Promise.resolve(undefined));
    const cached = cacheFn.memoize(source);
    await expect(cached()).rejects.toThrow('retry'); reject = false;
    const first = cached(); expect(cached()).toBe(first); await first; expect(await cached()).toBeUndefined();
    expect(source).toHaveBeenCalledTimes(2);
  });
  it('prevents pending work from repopulating after invalidation', async () => {
    let resolve!: (value: number) => void;
    const cached = cacheFn.memoize(() => new Promise<number>(r => resolve = r));
    const pending = cached(); await cached.clear(); resolve(1); expect(await pending).toBe(1);
    expect((await cached.stats()).size).toBe(0);
  });
  it('exposes one coherent CacheFn for synchronous controls and statistics', async () => {
    const source = vi.fn((n: number) => n + 1);
    const cached = cacheFn.memoize(source, { keyGenerator: n => String(n) });
    expect(cached.cache).toBeInstanceOf(CacheFn);
    expect(cached(1)).toBe(2); expect(await cached.cache.get('1')).toBe(2);
    await cached.cache.set('1', 9); expect(cached(1)).toBe(9);
    expect(source).toHaveBeenCalledTimes(1);
    await cached.cache.delete('1'); expect(cached(1)).toBe(2);
    expect(await cached.stats()).toEqual(await cached.cache.getStats());
    await cached.cache.clear(); expect((await cached.stats()).size).toBe(0);
  });
  it('cache-view writes invalidate pending asynchronous results', async () => {
    let resolve!: (value: number) => void;
    const cached = cacheFn.memoize(() => new Promise<number>(r => resolve = r), { keyGenerator: () => 'key' });
    const pending = cached();
    await cached.cache.set('key', Promise.resolve(9));
    resolve(1); expect(await pending).toBe(1); expect(await cached()).toBe(9);
    await cached.cache.clear(); expect((await cached.stats()).size).toBe(0);
  });
  it('exposes raw persistent cache values and prevents late writes through its cache view', async () => {
    let resolve!: (value: number) => void;
    const cached = cacheFn.memoize(() => new Promise<number>(r => resolve = r), { storage: 'indexeddb', keyGenerator: () => 'key' });
    await cached.cache.set('key', 9); expect(await cached()).toBe(9);
    await cached.cache.delete('key'); const pending = cached();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await cached.cache.set('key', 7); resolve(1);
    expect(await pending).toBe(1); expect(await cached()).toBe(7);
    await cached.cache.clear(); expect((await cached.stats()).size).toBe(0);
  });
  it.each(['factory', 'standalone'] as const)('invalidates %s cache-view tags/patterns without retaining stale results', async mode => {
    const source = vi.fn((n: number) => n + 1);
    const options = { keyGenerator: (n: number) => `key:${n}`, tags: ['group'] };
    const cached = mode === 'factory' ? cacheFn.memoize(source, options) : memoize(source, options);
    expect(await cached(1)).toBe(2);
    await cached.cache.invalidateByTag('group'); expect(await cached(1)).toBe(2);
    await cached.cache.invalidateByPattern('key:*'); expect(await cached(1)).toBe(2);
    expect(source).toHaveBeenCalledTimes(3);
    await cached.delete(1); expect((await cached.stats()).size).toBe(0);
  });
  it('propagates synchronous failures and retries subsequent calls', () => {
    let fail = true;
    const cached = cacheFn.memoize(() => { if (fail) throw new Error('retry'); return 1; });
    expect(() => cached()).toThrow('retry'); fail = false; expect(cached()).toBe(1);
  });
  it('keeps middleware factories identical to standalone exports', () => {
    expect(cacheFn.middleware).toBe(expressMiddleware);
    expect(cacheFn.hono).toBe(honoMiddleware);
    expect(cacheFn.fastify).toBe(fastifyPlugin);
  });
});
