import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheFn } from '../src/core/cache.js';

const instances: CacheFn<any>[] = [];
const make = (config: Partial<ConstructorParameters<typeof CacheFn>[0]> = {}) => {
  const cache = new CacheFn<any>({name:'registry', ...config}); instances.push(cache); return cache;
};
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return {promise,resolve};
};
afterEach(() => { instances.splice(0).forEach(cache => cache.dispose()); vi.unstubAllGlobals(); });

describe('bounded refresh registration lifecycle', () => {
  it('bounds the default registry independently of a zero entry capacity without rejecting reads', async () => {
    const cache = make({maxSize:0});
    for (let index=0;index<1001;index++) expect(await cache.getOrFetch(String(index), {fetcher:async()=>index})).toBe(index);
    expect(await cache.size()).toBe(0);
    expect(cache.unregisterFetcher('0')).toBe(false);
    for (let index=1;index<=1000;index++) expect(cache.unregisterFetcher(String(index))).toBe(true);
  });

  it('retains the most recently requested callbacks and replacements without evicting values', async () => {
    const cache = make({maxRegisteredFetchers:2});
    const first = vi.fn(async()=>1), second = vi.fn(async()=>2), replacement = vi.fn(async()=>10), third = vi.fn(async()=>3);
    await cache.getOrFetch('a', {fetcher:first}); await cache.getOrFetch('b', {fetcher:second});
    expect(await cache.getOrFetch('a', {fetcher:replacement})).toBe(1);
    await cache.getOrFetch('c', {fetcher:third});
    expect(await cache.get('b')).toBe(2); expect(cache.unregisterFetcher('b')).toBe(false);
    await cache.refresh();
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1); expect(third).toHaveBeenCalledTimes(2);
    expect(await cache.get('a')).toBe(10);
  });

  it('allows zero retention and leaves non-offline function-overload calls unregistered', async () => {
    const zero = make({maxRegisteredFetchers:0,offlineStrategy:'cache-first'});
    const fetch = vi.fn(async()=>1); await zero.getOrFetch('a',{fetcher:fetch}); await zero.refresh();
    expect(fetch).toHaveBeenCalledTimes(1); expect(zero.unregisterFetcher('a')).toBe(false);
    const ordinary = make(); await ordinary.getOrFetch('a',fetch); await ordinary.refresh();
    expect(fetch).toHaveBeenCalledTimes(2); expect(ordinary.unregisterFetcher('a')).toBe(false);
  });

  it('preserves registrations across entry invalidation and allows explicit release/re-registration', async () => {
    const cache = make(); const fetch = vi.fn(async()=>1);
    await cache.getOrFetch('a',{fetcher:fetch}); await cache.delete('a'); await cache.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.unregisterFetcher('a')).toBe(true); expect(cache.unregisterFetcher('a')).toBe(false);
    expect(await cache.get('a')).toBe(1); await cache.clear(); await cache.refresh();
    expect(await cache.has('a')).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
    await cache.getOrFetch('a',{fetcher:fetch}); await cache.clear(); await cache.refresh();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not start removed callbacks or newly added keys during an active refresh', async () => {
    const cache = make({maxRegisteredFetchers:3}); const started=deferred(), gate=deferred<number>();
    await cache.set('a',0); await cache.set('b',0);
    await cache.getOrFetch('a',{fetcher:()=>{started.resolve();return gate.promise}});
    const removed=vi.fn(async()=>2); await cache.getOrFetch('b',{fetcher:removed});
    const active=cache.refresh(); expect(cache.refresh()).toBe(active); await started.promise;
    expect(cache.unregisterFetcher('b')).toBe(true);
    const added=vi.fn(async()=>3); await cache.getOrFetch('c',{fetcher:added});
    gate.resolve(1); await active;
    expect(removed).not.toHaveBeenCalled(); expect(added).toHaveBeenCalledTimes(1);
    await cache.refresh(); expect(added).toHaveBeenCalledTimes(2);
  });

  it('uses a replacement callback while retaining refresh recency order', async () => {
    const cache = make({maxRegisteredFetchers:2}); const started=deferred(), gate=deferred<number>();
    await cache.set('a',0); await cache.set('b',0);
    await cache.getOrFetch('a',{fetcher:()=>{started.resolve();return gate.promise}});
    const old=vi.fn(async()=>2), replacement=vi.fn(async()=>20);
    await cache.getOrFetch('b',{fetcher:old}); const refresh=cache.refresh(); await started.promise;
    await cache.getOrFetch('b',{fetcher:replacement}); gate.resolve(1); await refresh;
    expect(old).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledTimes(1);
    await cache.getOrFetch('c',{fetcher:async()=>3});
    expect(cache.unregisterFetcher('a')).toBe(false); expect(cache.unregisterFetcher('b')).toBe(true);
  });

  it('does not let background refresh reorder explicit request recency', async () => {
    const cache=make({maxRegisteredFetchers:2}); const started=deferred(), gate=deferred<number>();
    const fetch=()=>{started.resolve();return gate.promise};
    await cache.set('a',0); await cache.set('b',0);
    await cache.getOrFetch('a',{fetcher:fetch}); await cache.getOrFetch('b',{fetcher:async()=>2});
    const refresh=cache.refresh(); await started.promise;
    const touched=cache.getOrFetch('a',{fetcher:fetch}); // Most recent explicit request is a.
    gate.resolve(1); await Promise.all([refresh,touched]);
    await cache.getOrFetch('c',{fetcher:async()=>3});
    expect(cache.unregisterFetcher('b')).toBe(false); expect(cache.unregisterFetcher('a')).toBe(true);
  });

  it('skips a snapshot key whose callback was evicted before its refresh turn', async () => {
    const cache=make({maxRegisteredFetchers:2}); const started=deferred(), gate=deferred<number>();
    const fetch=()=>{started.resolve();return gate.promise}; const evicted=vi.fn(async()=>2);
    await cache.set('a',0); await cache.set('b',0);
    await cache.getOrFetch('a',{fetcher:fetch}); await cache.getOrFetch('b',{fetcher:evicted});
    const refresh=cache.refresh(); await started.promise;
    const touched=cache.getOrFetch('a',{fetcher:fetch});
    const added=vi.fn(async()=>3); await cache.getOrFetch('c',{fetcher:added});
    gate.resolve(1); await Promise.all([refresh,touched]);
    expect(evicted).not.toHaveBeenCalled(); expect(added).toHaveBeenCalledTimes(1);
  });

  it('rechecks removal after waiting for an existing fetch', async () => {
    const cache=make(); const started=deferred(), gate=deferred<number>(); const fetch=vi.fn(()=>{started.resolve();return gate.promise});
    const read=cache.getOrFetch('a',{fetcher:fetch}); await started.promise;
    const refresh=cache.refresh(); await Promise.resolve(); await Promise.resolve();
    cache.unregisterFetcher('a'); gate.resolve(1); await Promise.all([read,refresh]);
    expect(fetch).toHaveBeenCalledTimes(1); expect(await cache.get('a')).toBe(1);
  });

  it('releases registrations on disposal without cancelling caller-owned work or retaining later calls', async () => {
    const cache=make(); const started=deferred(), gate=deferred<number>();
    const read=cache.getOrFetch('a',{fetcher:()=>{started.resolve();return gate.promise}}); await started.promise;
    await cache.set('b',2); await cache.getOrFetch('b',{fetcher:async()=>3});
    cache.dispose(); expect(cache.unregisterFetcher('a')).toBe(false); expect(cache.unregisterFetcher('b')).toBe(false);
    gate.resolve(1); expect(await read).toBe(1); expect(await cache.has('a')).toBe(false);
    expect(await cache.getOrFetch('b',{fetcher:async()=>3})).toBe(2); expect(cache.unregisterFetcher('b')).toBe(false);
    await expect(cache.refresh()).rejects.toThrow('disposed');
  });

  it('keeps offline queued writes independent of registration eviction and release', async () => {
    let online=false; vi.stubGlobal('navigator',{get onLine(){return online}});
    const delivered:string[]=[]; const cache=make({offlineStrategy:'cache-first',maxRegisteredFetchers:1,offlineQueue:{sync:async({key})=>{delivered.push(key)}}});
    await cache.getOrFetch('a',{fetcher:async()=>1,offlineFallback:()=>0});
    const id=await cache.queueUpdate('a',10);
    const latest=vi.fn(async()=>2); await cache.getOrFetch('b',{fetcher:latest,offlineFallback:()=>0});
    expect(cache.unregisterFetcher('a')).toBe(false); expect((await cache.queuedUpdates())[0].id).toBe(id);
    online=true; await cache.sync(); await cache.refresh();
    expect(delivered).toEqual(['a']); expect(latest).toHaveBeenCalledTimes(1); expect(await cache.get('a')).toBe(10);
  });

  it.each([-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])('rejects invalid retention limit %s',maxRegisteredFetchers=>{
    expect(()=>make({maxRegisteredFetchers})).toThrow(/maxRegisteredFetchers/);
  });
});
