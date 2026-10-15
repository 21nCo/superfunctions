/** V0 factory convenience: synchronous memory memoization with a coherent CacheFn view. */
import type { MemoizeOptions, MemoizedFunction, SetOptions, ClearOptions } from '../core/types.js';
import { memoize, type AsyncMemoized } from './memoize.js';
import { CacheFn } from '../core/cache.js';
import { MemoryStorage } from '../storage/memory-storage.js';
import { generateKey } from '../utils/hash.js';
import { calculateExpiration } from '../strategies/ttl-manager.js';

type Callable = (this: any, ...args: any[]) => any;
type MemoryMemoized<T extends Callable> = T & MemoizedFunction & { cache: CacheFn<ReturnType<T>> };
class MemoMemoryCache<T> extends CacheFn<T> {
  constructor(maxSize: number, private invalidatePending: (key?: string) => void) { super({ name: 'memoize-memory', maxSize }); }
  lookup(key: string): { found: boolean; value?: T } {
    const storage = this.storage as MemoryStorage<T>, fullKey = this.getFullKey(key);
    const value = storage.getSync(fullKey);
    const found = value !== undefined || storage.hasSync(fullKey);
    if (found) this.stats.recordHit(); else this.stats.recordMiss();
    this.events.emit(found ? 'hit' : 'miss', found ? { key, accessTime: 0 } : { key });
    return { found, value };
  }
  storeResult(key: string, value: T, options?: SetOptions): void {
    const now = Date.now();
    (this.storage as MemoryStorage<T>).setSync(this.getFullKey(key), value, { createdAt: now, lastAccess: now, hits: 0, expiresAt: calculateExpiration(options?.ttl), tags: options?.tags });
    this.stats.recordSet(); this.events.emit('set', { key, size: 1 });
  }
  override async set(key: string, value: T, options?: SetOptions): Promise<void> { this.invalidatePending(key); await super.set(key, value, options); }
  override async delete(key: string): Promise<boolean> { this.invalidatePending(key); return super.delete(key); }
  override async clear(options?: ClearOptions): Promise<void> { this.invalidatePending(); await super.clear(options); }
  override async invalidateByTag(tag: string): Promise<void> { this.invalidatePending(); await super.invalidateByTag(tag); }
  override async invalidateByPattern(pattern: string | RegExp): Promise<void> { this.invalidatePending(); await super.invalidateByPattern(pattern); }
}
export function compatibleMemoize<T extends Callable>(fn: T, options?: MemoizeOptions<T> & { storage?: 'memory' }): MemoryMemoized<T>;
export function compatibleMemoize<T extends Callable>(fn: T, options: MemoizeOptions<T> & { storage: 'indexeddb' | 'localstorage' | 'auto' }): AsyncMemoized<T>;
export function compatibleMemoize<T extends Callable>(fn: T, options: MemoizeOptions<T>): ((this: ThisParameterType<T>, ...args: Parameters<T>) => ReturnType<T> | Promise<Awaited<ReturnType<T>>>) & MemoizedFunction & { cache: CacheFn<any> };
export function compatibleMemoize<T extends Callable>(fn: T, options?: MemoizeOptions<T>): any {
  if (options?.storage && options.storage !== 'memory') return memoize(fn, options);
  const keyFor = options?.keyGenerator ?? ((...args: Parameters<T>) => generateKey(fn.name || 'fn', args));
  const flights = new Map<string, Promise<any>>();
  const tokens = new Map<string, object>();
  const cache = new MemoMemoryCache<ReturnType<T>>(options?.maxSize ?? 1000, key => {
    if (key === undefined) { tokens.clear(); flights.clear(); }
    else { tokens.delete(key); flights.delete(key); }
  });
  const wrapped = function (this: any, ...args: Parameters<T>): ReturnType<T> {
    const key = keyFor(...args);
    const flight = flights.get(key); if (flight) return flight as ReturnType<T>;
    const entry = cache.lookup(key); if (entry.found) return entry.value!;
    const token = {}; tokens.set(key, token);
    let value: ReturnType<T>;
    try { value = fn.apply(this, args); }
    catch (error) { if (tokens.get(key) === token) tokens.delete(key); throw error; }
    if (value && typeof value.then === 'function') {
      const promise = Promise.resolve(value).then(result => {
        if (tokens.get(key) === token) cache.storeResult(key, Promise.resolve(result) as ReturnType<T>, options);
        return result;
      }).finally(() => { if (tokens.get(key) === token) { tokens.delete(key); flights.delete(key); } });
      if (tokens.get(key) === token) flights.set(key, promise);
      return promise as ReturnType<T>;
    }
    if (tokens.get(key) === token) { cache.storeResult(key, value, options); tokens.delete(key); }
    return value;
  };
  wrapped.cache = cache;
  wrapped.clear = () => cache.clear();
  wrapped.delete = async (...args: Parameters<T>) => { await cache.delete(keyFor(...args)); };
  wrapped.stats = () => cache.getStats();
  return wrapped;
}
