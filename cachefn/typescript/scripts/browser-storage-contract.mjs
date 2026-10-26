/** Shared browser storage assertions; run only in an owned disposable origin. */
export async function storageContract() {
    const { CacheFn, IndexedDBStorage } = globalThis.Acceptance;
    let assertions = 0;
    const assert = (value, message) => {
      if (!value) throw new Error(message);
      assertions++;
    };
    // Bound observation without retaining a timer after success/failure.
    let timeout;
    try {
      return await Promise.race([
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Browser acceptance timed out")), 15000);
        }),
        (async () => {
          const name = `acceptance-${crypto.randomUUID()}`;
          const root = new CacheFn({ name, storage: "indexeddb" });
          const parent = new CacheFn({ name, namespace: "a", storage: "indexeddb" });
          const child = new CacheFn({ name, namespace: "a:b", storage: "indexeddb" });
          await Promise.all([
            root.set("a:b:item", "root", { tags: ["shared"] }),
            parent.set("b:item", "parent", { tags: ["shared"] }),
            child.set("item", "child", { tags: ["shared"] }),
          ]);
          assert((await root.keys()).join() === "a:b:item", "default namespace keys");
          assert((await parent.keys()).join() === "b:item", "parent namespace keys");
          assert((await child.keys()).join() === "item", "child namespace keys");
          await parent.invalidateByTag("shared");
          assert(await child.get("item") === "child", "child survives tag invalidation");
          await root.clear();
          assert(await child.get("item") === "child", "child survives default clear");
          await child.set("expired", "old", { ttl: -1, tags: ["expired"] });
          assert(!(await child.keys()).includes("expired"), "expired enumeration");
          assert(await child.size() === 1, "expired size");
          const directName = `direct-${crypto.randomUUID()}`;
          const storage = new IndexedDBStorage({ name: directName });
          const metadata = { createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags: ["old"] };
          await storage.set("key", 1, metadata);
          await storage.addTag("new", "key");
          assert((await storage.getTagsForKey("key")).includes("new"), "tag metadata consistency");
          await storage.removeTag("old", "key");
          assert((await storage.getKeysByTag("old")).length === 0, "tag removal consistency");
          let rejected = false;
          try { await storage.set("key", () => 1, metadata); } catch { rejected = true; }
          assert(rejected, "uncloneable write rejects");
          assert(await storage.get("key") === 1, "failed write rollback");
          const original = IDBObjectStore.prototype.delete;
          rejected = false;
          try {
            IDBObjectStore.prototype.delete = function (key) {
              const request = original.call(this, key);
              request.addEventListener("success", () => this.transaction.abort());
              return request;
            };
            try { await storage.delete("key"); } catch { rejected = true; }
          } finally {
            IDBObjectStore.prototype.delete = original;
          }
          assert(rejected, "abort after request success rejects");
          assert(await storage.has("key"), "aborted delete rollback");
          storage.close();
          const reopenedStorage = new IndexedDBStorage({ name: directName });
          assert(await reopenedStorage.get("key") === 1, "IndexedDB persists across closed connections");
          assert((await reopenedStorage.getTagsForKey("key")).includes("new"), "IndexedDB tags persist across closed connections");
          reopenedStorage.close();
          const batch = new CacheFn({ name, storage: 'indexeddb', namespace: 'batch' });
          const batchNeighbor = new CacheFn({ name, storage: 'indexeddb', namespace: 'batch:neighbor' });
          await batch.set('match:a', 1); await batch.set('match:b', 2);
          await batchNeighbor.set('match:a', 3);
          const deletionEvents = [], invalidationEvents = [];
          batch.on('delete', event => deletionEvents.push(event));
          batch.on('invalidate', event => invalidationEvents.push(event));
          rejected = false;
          try {
            IDBObjectStore.prototype.delete = function (key) {
              const request = original.call(this, key);
              if (String(key).endsWith('match:b')) request.addEventListener('success', () => this.transaction.abort());
              return request;
            };
            try { await batch.invalidateByPattern('match:*'); } catch { rejected = true; }
          } finally { IDBObjectStore.prototype.delete = original; }
          assert(rejected, 'batch invalidation abort rejects');
          assert((await batch.getMany(['match:a', 'match:b'])).join() === '1,2', 'batch abort rolls back every key');
          assert(deletionEvents.length === 0 && invalidationEvents.length === 0, 'batch abort emits no success');
          assert((await batch.getStats()).deletes === 0, 'batch abort preserves delete statistics');
          await batch.invalidateByPattern('match:*');
          assert(await batch.size() === 0, 'batch invalidation committed');
          assert(await batchNeighbor.get('match:a') === 3, 'batch invalidation preserves adjacent namespace');
          assert(deletionEvents.length === 2 && invalidationEvents[0]?.count === 2, 'batch commit emits accurate counts');
          assert((await batch.getStats()).deletes === 2, 'batch commit updates statistics');
          batch.dispose(); batchNeighbor.dispose();
          const persistentName = `local-${crypto.randomUUID()}`;
          const local = new CacheFn({ name: persistentName, storage: 'localstorage', namespace: 'one' });
          await local.set('key', { value: 1n }, { tags: ['tag'] });
          const reopened = new CacheFn({ name: persistentName, storage: 'localstorage', namespace: 'one' });
          assert((await reopened.get('key')).value === 1n, 'localStorage typed persistence');
          const neighbor = new CacheFn({ name: persistentName, storage: 'localstorage', namespace: 'one:two' });
          await neighbor.set('key', 2, { tags: ['tag'] });
          await local.invalidateByTag('tag');
          assert(await neighbor.get('key') === 2, 'localStorage namespace isolation');
          const open = indexedDB.open.bind(indexedDB);
          indexedDB.open = () => { throw new DOMException('Disabled by browser policy', 'SecurityError'); };
          try {
            const automaticName = `automatic-${crypto.randomUUID()}`;
            const automatic = new CacheFn({ name: automaticName, storage: 'auto' });
            await automatic.set('key', 3);
            assert(await new CacheFn({ name: automaticName, storage: 'localstorage' }).get('key') === 3, 'disabled IndexedDB falls to localStorage');
            const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
            Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Disabled storage', 'SecurityError'); } });
            try {
              const memory = new CacheFn({ name: crypto.randomUUID(), storage: 'auto' });
              await memory.set('key', 4);
              assert(await memory.get('key') === 4, 'all persistent storage denied falls to memory');
            } finally {
              if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
              else delete window.localStorage;
            }
          } finally { indexedDB.open = open; }
          const quota = new CacheFn({ name: crypto.randomUUID(), storage: 'auto', fallbackOrder: ['localstorage'], localStorageMaxBytes: 40 * 1024 * 1024 });
          // Above common native localStorage quotas, below the configured library
          // cap. Require an actual native rejection instead of assuming one.
          const large = 'x'.repeat(10 * 1024 * 1024);
          const nativeSetItem = Storage.prototype.setItem;
          let quotaErrors = 0;
          try {
            Storage.prototype.setItem = function (...args) {
              try { return nativeSetItem.apply(this, args); }
              catch (error) { if (error instanceof DOMException && error.name === 'QuotaExceededError') quotaErrors++; throw error; }
            };
            await quota.set('large', large);
          } finally { Storage.prototype.setItem = nativeSetItem; }
          assert(quotaErrors > 0, 'native QuotaExceededError observed');
          assert((await quota.get('large')).length === large.length, 'native browser quota falls to memory');
          assert(!Object.keys(localStorage).some(key => key.includes(':probe:')), 'localStorage probes cleaned');
          const autoIdb = new CacheFn({ name: `auto-idb-${crypto.randomUUID()}`, storage: 'auto' });
          await autoIdb.set('key', 5);
          assert(await autoIdb.get('key') === 5, 'automatic IndexedDB works');
          if (typeof indexedDB.databases === 'function') assert(!(await indexedDB.databases()).some(db => db.name?.includes(':probe:')), 'IndexedDB probe databases removed');
          // Bulk auto operations must remain on their selected transactional tier.
          const bulkName = `auto-bulk-${crypto.randomUUID()}`;
          const bulk = new CacheFn({ name: bulkName, namespace: 'one', storage: 'auto' });
          const other = new CacheFn({ name: bulkName, namespace: 'two', storage: 'auto' });
          await bulk.set('match', 1); await bulk.set('keep', 2); await other.set('match', 3);
          await bulk.invalidateByPattern('match');
          assert(await bulk.get('keep') === 2 && await other.get('match') === 3, 'auto bulk preserves unmatched and foreign keys');
          await bulk.set('match', 4);
          let events = 0;
          bulk.on('delete', () => events++); bulk.on('invalidate', () => events++);
          const originalDelete = IDBObjectStore.prototype.delete;
          let aborted = false;
          IDBObjectStore.prototype.delete = function(key) {
            const request = originalDelete.call(this, key);
            request.addEventListener('success', () => this.transaction.abort());
            return request;
          };
          try { await bulk.invalidateByPattern('match'); } catch { aborted = true; }
          finally { IDBObjectStore.prototype.delete = originalDelete; }
          assert(aborted && events === 0, 'auto bulk abort emits no committed event');
          assert(await bulk.get('match') === 4, 'auto bulk abort does not replay into fallback');
          const complete = new IndexedDBStorage({ name: `complete-${crypto.randomUUID()}` });
          await complete.set('a', 1, metadata); await complete.set('z', 2, metadata);
          await complete.set('expired', 3, { ...metadata, expiresAt: Date.now() - 1 });
          let predicateRejected = false;
          try { await complete.deleteMatching(key => { if (key === 'z') throw Error('predicate'); return true; }); }
          catch { predicateRejected = true; }
          assert(predicateRejected && await complete.get('a') === 1, 'complete scan rejects before clear');
          assert((await complete.deleteMatching(() => true)).join() === 'a,z' && await complete.size() === 0, 'clear receipt excludes expired keys');
          complete.close(); bulk.dispose(); other.dispose();
          const heapDescriptor = Object.getOwnPropertyDescriptor(performance, 'memory');
          const heap = { usedJSHeapSize: 90, jsHeapSizeLimit: 100 };
          Object.defineProperty(performance, 'memory', { configurable: true, value: heap });
          const adaptive = new CacheFn({ name: crypto.randomUUID(), storage: 'memory', eviction: 'adaptive', memoryMonitoring: { checkInterval: 10 } });
          try {
            await adaptive.set('low', 1, { priority: 'low' });
            await adaptive.set('high', 2, { priority: 'high' });
            await new Promise(resolve => adaptive.on('eviction', () => { heap.usedJSHeapSize = 10; resolve(); }));
            assert(!await adaptive.has('low') && await adaptive.has('high'), 'adaptive browser timer evicts low priority first');
            adaptive.dispose(); heap.usedJSHeapSize = 99;
            await new Promise(resolve => setTimeout(resolve, 30));
            assert(await adaptive.has('high'), 'disposed adaptive monitor preserves entries under pressure');
          } finally {
            adaptive.dispose();
            if (heapDescriptor) Object.defineProperty(performance, 'memory', heapDescriptor);
            else delete performance.memory;
          }
          return { assertions, userAgent: navigator.userAgent };
        })(),
      ]);
    } finally {
      clearTimeout(timeout);
    }
}
