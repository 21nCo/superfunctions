import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/storage/memory-storage.js';
import { CacheFn } from '../src/core/cache.js';
const metadata = (tags = ['old'], expiresAt?: number) => ({ createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags, expiresAt });

describe('memory tag consistency', () => {
  it('keeps metadata and indexes synchronized through tag mutation and metadata-preserving rewrites', async () => {
    const storage = new MemoryStorage();
    await storage.set('key', 1, metadata());
    await storage.addTag('new', 'key');
    await storage.addTag('new', 'key');
    await storage.removeTag('old', 'key');
    expect(await storage.getTagsForKey('key')).toEqual(['new']);
    expect((await storage.getMetadata('key'))?.tags).toEqual(['new']);
    expect(await storage.getKeysByTag('old')).toEqual([]);
    await storage.set('key', 2, (await storage.getMetadata('key'))!);
    expect(await storage.getKeysByTag('new')).toEqual(['key']);
    await storage.delete('key');
    expect(await storage.getKeysByTag('new')).toEqual([]);
  });
  it('does not expose or create tags for absent and expired entries', async () => {
    const storage = new MemoryStorage();
    await storage.addTag('orphan', 'missing');
    expect(await storage.getTagsForKey('missing')).toEqual([]);
    expect(await storage.getKeysByTag('orphan')).toEqual([]);
    await storage.set('expired', 1, metadata(['old'], Date.now() - 1));
    await storage.addTag('new', 'expired');
    expect(await storage.getTagsForKey('expired')).toEqual([]);
    expect(await storage.getKeysByTag('old')).toEqual([]);
    expect(await storage.getKeysByTag('new')).toEqual([]);
    expect(await storage.getMetadata('expired')).toBeUndefined();
  });
});

describe('eviction observer reentrancy', () => {
  it('keeps capacity bounded when eviction listeners write another entry', async () => {
    const cache = new CacheFn<number>({ name: 'reentrant', maxSize: 1 });
    await cache.set('initial', 1, { tags: ['initial'] });
    let once = true;
    cache.on('eviction', () => { if (once) { once = false; void cache.set('listener', 3, { tags: ['listener'] }); } });
    await cache.set('outer', 2, { tags: ['outer'] });
    expect(await cache.size()).toBe(1);
    expect(await cache.keys()).toEqual(['listener']);
    expect(await cache.get('listener')).toBe(3);
    expect(await cache.get('outer')).toBeUndefined();
    expect((await cache.getStats()).evictions).toBe(2);
    await cache.invalidateByTag('outer');
    expect(await cache.get('listener')).toBe(3);
    await cache.invalidateByTag('listener');
    expect(await cache.size()).toBe(0);
  });
  it('lets an eviction listener clear the completed write without resurrection', async () => {
    const cache = new CacheFn({ name: 'clear-on-eviction', maxSize: 1 });
    await cache.set('initial', 1);
    let clearing: Promise<void> | undefined;
    cache.on('eviction', () => { clearing = cache.clear(); });
    await cache.set('outer', 2);
    await clearing;
    expect(await cache.size()).toBe(0);
  });
});
