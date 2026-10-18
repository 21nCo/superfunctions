import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheFn } from '../src/core/cache.js';

const instances: CacheFn[] = [];
const memory = { usedJSHeapSize: 90, jsHeapSizeLimit: 100 };
function make(extra: Record<string, unknown> = {}) {
  const cache = new CacheFn({ name: 'adaptive', eviction: 'adaptive', memoryMonitoring: { checkInterval: 10 }, ...extra });
  instances.push(cache); return cache;
}
function setup() {
  vi.useFakeTimers();
  memory.usedJSHeapSize = 90;
  Object.defineProperty(performance, 'memory', { configurable: true, value: memory });
}
afterEach(() => {
  instances.splice(0).forEach(cache => cache.dispose());
  delete (performance as any).memory;
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('adaptive browser memory monitoring', () => {
  it('evicts low then normal then high under sustained pressure, maintaining tags/events/stats', async () => {
    setup(); const cache = make(); const events: string[] = [];
    cache.on('eviction', event => events.push(event.key));
    await cache.set('high', 3, { priority: 'high', tags: ['group'] });
    await cache.set('normal', 2, { tags: ['group'] });
    await cache.set('low', 1, { priority: 'low', tags: ['group'] });
    await vi.advanceTimersByTimeAsync(10);
    expect(await cache.keys()).toEqual(['high', 'normal']);
    expect(events).toEqual(['low']);
    expect((await cache.getStats()).evictions).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(await cache.keys()).toEqual(['high']);
    await vi.advanceTimersByTimeAsync(10);
    expect(await cache.keys()).toEqual([]);
    expect(events).toEqual(['low', 'normal', 'high']);
    const invalidated = vi.fn(); cache.on('invalidate', invalidated);
    await cache.invalidateByTag('group');
    expect(invalidated).toHaveBeenCalledWith(expect.objectContaining({ count: 0 }));
  });
  it('resamples usage, respects threshold equality, and preserves recovered entries', async () => {
    setup(); const cache = make(); await cache.set('low', 1, { priority: 'low' });
    memory.usedJSHeapSize = 80;
    await vi.advanceTimersByTimeAsync(20); expect(await cache.has('low')).toBe(true);
    memory.usedJSHeapSize = 81;
    await vi.advanceTimersByTimeAsync(10); expect(await cache.has('low')).toBe(false);
    memory.usedJSHeapSize = 20; await cache.set('safe', 2);
    await vi.advanceTimersByTimeAsync(20); expect(await cache.has('safe')).toBe(true);
  });
  it('filtered clear removes only the requested priority and keeps other entries and stats', async () => {
    const cache = make({ eviction: 'lru' });
    await cache.set('low', 1, { priority: 'low' }); await cache.set('normal', 2); await cache.set('high', 3, { priority: 'high' });
    await cache.clear({ priority: 'low' }); expect(await cache.keys()).toEqual(['normal', 'high']);
    expect((await cache.getStats()).sets).toBe(3);
    await cache.clear({ priority: 'normal' }); expect(await cache.keys()).toEqual(['high']);
  });
  it('does not allocate timers for unsupported, disabled, persistent, or nonadaptive configurations', () => {
    vi.useFakeTimers(); make();
    setup(); make({ memoryMonitoring: { enabled: false } }); make({ storage: 'indexeddb' }); make({ eviction: 'lru' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('disposes idempotently without clearing data or retaining timers', async () => {
    setup(); const cache = make(); await cache.set('key', 1);
    expect(vi.getTimerCount()).toBe(1); cache.dispose(); cache.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100); expect(await cache.get('key')).toBe(1);
  });
  it('supports the memory tier in auto mode without initializing unused persistent storage', async () => {
    setup(); const cache = make({ storage: 'auto', fallbackOrder: ['memory'] });
    await cache.set('low', 1, { priority: 'low' });
    await vi.advanceTimersByTimeAsync(10); expect(await cache.has('low')).toBe(false);
  });
  it('ignores invalid or inaccessible runtime samples and rejects invalid options', async () => {
    setup(); const cache = make(); await cache.set('key', 1);
    memory.jsHeapSizeLimit = 0;
    await vi.advanceTimersByTimeAsync(10); expect(await cache.has('key')).toBe(true);
    memory.jsHeapSizeLimit = 100;
    expect(() => make({ memoryMonitoring: { threshold: 0 } })).toThrow(RangeError);
    expect(() => make({ memoryMonitoring: { checkInterval: 0 } })).toThrow(RangeError);
    await expect(cache.set('bad', 1, { priority: 'bad' as any })).rejects.toThrow(TypeError);
    await expect(cache.clear({ priority: 'bad' as any })).rejects.toThrow(TypeError);
  });
});
