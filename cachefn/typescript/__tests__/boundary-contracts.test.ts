import { describe, expect, it, vi } from 'vitest';
import { AutoStorage, LocalStorage, MemoryStorage, EventEmitter, LRUList, hash, hashArgs, serialize, deserialize, estimateSize, getRemainingTTL, cacheFn } from '../src/index.js';
const metadata = () => ({ createdAt: Date.now(), lastAccess: Date.now(), hits: 0 });

describe('serialization trust boundary', () => {
  it.each([
    null, [], [1], ['unknown'], ['null', 1], ['undefined', 1], ['string', 1], ['boolean', 1],
    ['number'], ['number', 1], ['number', 'garbage'], ['date', 'bad'], ['bigint', '1.2'],
    ['regexp', 'x', 'g', -1], ['regexp', 'x', 1, 0], ['array', 1], ['set', 1],
    ['map', 1], ['map', [['string', 'key']]], ['object', [[1, ['null']]]],
    ['object', [['same', ['null']], ['same', ['null']]]],
  ])('rejects malformed tagged payload %j', node => {
    expect(() => deserialize(JSON.stringify({ format: 'cachefn/1', value: node }))).toThrow(TypeError);
  });
  it('roundtrips null/boolean/dictionaries and rejects invalid RegExp/symbol properties', () => {
    const dictionary = Object.assign(Object.create(null), { null: null, flag: true });
    expect(deserialize(serialize(dictionary))).toEqual(dictionary);
    const regex = /x/g; regex.lastIndex = -1;
    expect(() => serialize(regex)).toThrow(TypeError);
    expect(() => serialize({ [Symbol('hidden')]: 1 })).toThrow(TypeError);
    expect(() => serialize(new Error('unsupported'))).toThrow(TypeError);
    expect(deserialize('null')).toBeNull();
  });
  it('estimates unsupported memory-only graphs without executing accessors or recursing cycles', () => {
    const getter = vi.fn(() => { throw new Error('must not run'); });
    const value: any = { fn: () => {}, absent: null, missing: undefined, string: 'text', number: 1 };
    value.map = new Map([[value, 'value']]); value.set = new Set([value, 2]);
    Object.defineProperty(value, 'getter', { enumerable: true, get: getter });
    expect(estimateSize(value)).toBeGreaterThan(0); expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('opaque'); }, ownKeys() { throw new Error('opaque'); } });
    expect(estimateSize(proxy)).toBe(0);
  });
});

describe('public utility lifecycle', () => {
  it('retains hash canonical distinctions and deterministic FNV output', () => {
    expect(hash('hello')).toBe('m3bicr'); expect(hash('')).toBe('ztntfp');
    expect(hashArgs([true, null])).not.toBe(hashArgs([false, null]));
    expect(() => hashArgs([{ [Symbol('key')]: 1 }])).toThrow(TypeError);
  });
  it('reports empty/nonempty LRU and nonexpiring/expired TTLs', () => {
    const lru = new LRUList(); expect(lru.getLRU()).toBeUndefined(); expect(lru.evictLRU()).toBeUndefined();
    lru.touch('one'); lru.touch('two'); expect(lru.getLRU()).toBe('one'); expect(lru.size).toBe(2);
    lru.remove('one'); expect(lru.evictLRU()).toBe('two'); expect(lru.size).toBe(0);
    expect(getRemainingTTL({ key: 'key', value: 1, ...metadata() })).toBeUndefined();
    expect(getRemainingTTL({ key: 'key', value: 1, ...metadata(), expiresAt: Date.now() - 1 })).toBe(0);
  });
  it('isolates observer errors, removes final listeners and clears all events', async () => {
    const emitter = new EventEmitter(); const fn = vi.fn(); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      emitter.on('event', () => { throw new Error('observer'); }); emitter.on('event', fn);
      emitter.emit('event', 1); expect(fn).toHaveBeenCalledWith(1); expect(log).toHaveBeenCalledTimes(1);
      emitter.removeAllListeners(); emitter.emit('event', 2); expect(fn).toHaveBeenCalledTimes(1);
      emitter.on('final', fn); emitter.off('final', fn); emitter.off('missing', fn); emitter.emit('final', 1);
      const cache = cacheFn({ name: 'events' }); cache.on('hit', fn); cache.off('hit', fn);
      await cache.set('one', 1); await cache.get('one'); expect(await cache.invalidate('one')).toBe(true);
    } finally { log.mockRestore(); }
  });
});

describe('automatic backend public operations', () => {
  it('keeps metadata/tag operations and deletion coherent through the auto abstraction', async () => {
    const storage = new AutoStorage({ name: 'all-operations', fallbackOrder: ['memory'] });
    await storage.set('one', 1, metadata()); await storage.addTag('tag', 'one');
    expect(await storage.getMetadata('one')).toMatchObject({ tags: ['tag'] });
    expect(await storage.getKeysByTag('tag')).toEqual(['one']); expect(await storage.getTagsForKey('one')).toEqual(['tag']);
    expect(await storage.size()).toBe(1); await storage.removeTag('tag', 'one'); expect(await storage.getKeysByTag('tag')).toEqual([]);
    expect(await storage.delete('one')).toBe(true); await storage.set('two', 2, metadata()); await storage.clear(); expect(await storage.size()).toBe(0);
  });
  it('rejects invalid resource settings before storage probing', () => {
    expect(() => new AutoStorage({ name: 'bad', storageProbeTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new LocalStorage({ name: 'bad', maxBytes: -1 })).toThrow(RangeError);
  });
  it('falls back after a nonresponsive IndexedDB availability probe', async () => {
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    try {
      const storage = new AutoStorage({ name: 'hung', fallbackOrder: ['indexeddb', 'memory'], storageProbeTimeoutMs: 1 });
      await storage.set('key', 1, metadata()); expect(await storage.get('key')).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('removes expired metadata/tags in every memory inspection path', async () => {
    const storage = new MemoryStorage();
    for (const method of ['getMetadata', 'has', 'size', 'removeTag'] as const) {
      await storage.set('key', 1, { ...metadata(), tags: ['tag'], expiresAt: Date.now() - 1 });
      if (method === 'removeTag') await storage.removeTag('tag', 'key');
      else if (method === 'size') expect(await storage.size()).toBe(0);
      else expect(await storage[method]('key')).toBeFalsy();
      expect(await storage.getKeysByTag('tag')).toEqual([]);
    }
  });
});
