/** Persistent cache storage. Each operation atomically updates one named cache. */
import type { CacheConfig } from './types.js';
export interface StoredEntry { data: unknown; timestamp: number; ttl: number; }
export type Entries = Map<string, StoredEntry>;
export interface CacheStore { run<T>(operation: (entries: Entries) => T): Promise<T>; }
const queues = new Map<string, Promise<unknown>>();
export function serializeOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  queues.set(id, result);
  void result.finally(() => { if (queues.get(id) === result) queues.delete(id); }).catch(() => {});
  return result;
}
// Tagged tuples encode the complete value, so user objects cannot collide with tags.
function encode(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  if (value instanceof Uint8Array) return ['bytes', Array.from(value)];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (Array.isArray(value)) return ['array', value.map(encode)];
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Unsupported cache object type');
    return ['object', Object.entries(value).map(([k, v]) => [k, encode(v)])];
  }
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Cache data must contain finite numbers');
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('Cache data is not serializable');
  return ['value', value];
}
function decode(value: any): any {
  switch (value[0]) {
    case 'undefined': return undefined;
    case 'bytes': return Uint8Array.from(value[1]);
    case 'date': return new Date(value[1]);
    case 'bigint': return BigInt(value[1]);
    case 'array': return value[1].map(decode);
    case 'object': return Object.fromEntries(value[1].map(([k, v]: [string, any]) => [k, decode(v)]));
    case 'value': return value[1];
    default: throw new Error('Invalid BrowseFn cache encoding');
  }
}
export const CACHE_DATABASE_SCHEMA = {
  browsefn_cache: { modelName: 'browsefn_cache', fields: { id: { type: 'string' as const, required: true, unique: true }, value: { type: 'string' as const, required: true }, revision: { type: 'number' as const, required: true } } },
};
const serialize = (entries: Entries) => JSON.stringify({ version: 1, entries: encode([...entries]) });
function deserialize(raw: string | undefined): Entries {
  if (raw === undefined) return new Map();
  const value = JSON.parse(raw);
  if (value.version !== 1) throw new Error('Unsupported BrowseFn cache version');
  return new Map(decode(value.entries));
}
export function createPersistentStore(config: CacheConfig): CacheStore {
  const name = config.name ?? 'browsefn';
  if (!name.trim()) throw new Error('Cache name must not be empty');
  if (config.storage === 'indexeddb') {
    let opening: Promise<IDBDatabase> | undefined;
    const open = () => opening ??= new Promise((resolve, reject) => {
      const factory = config.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new Error('IndexedDB unavailable; supply CacheConfig.indexedDB in this runtime')); return; }
      const request = factory.open('browsefn-cache-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('caches');
      request.onerror = () => { opening = undefined; reject(request.error); };
      request.onblocked = () => { opening = undefined; reject(new Error('BrowseFn cache database upgrade blocked')); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = undefined; }; resolve(db); };
    });
    return { async run(operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('caches', 'readwrite'); const store = tx.objectStore('caches');
        let result: any; let error: unknown;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(error ?? tx.error ?? new Error('Cache transaction aborted'));
        tx.onerror = () => { /* Abort settles the transaction. */ };
        const read = store.get(name);
        read.onsuccess = () => {
          try { const entries = deserialize(read.result); result = operation(entries); store.put(serialize(entries), name); }
          catch (failure) { error = failure; tx.abort(); }
        };
      });
    } };
  }
  if (config.storage === 'database') {
    if (!config.database) throw new Error('Database cache requires CacheConfig.database');
    return { async run(operation) {
      const { wrapWithSchema } = await import('@superfunctions/db');
      const db = wrapWithSchema(config.database!, CACHE_DATABASE_SCHEMA);
      const { createHash } = await import('node:crypto');
      const id = 'typescript:' + createHash('sha256').update(name).digest('hex');
      const where = [{ field: 'id', operator: 'eq' as const, value: id }];
      // One row contains the entire cache. Conditional updates atomically enforce
      // eviction/order even for shared adapters without transaction support.
      for (let attempt = 0; attempt < 32; attempt++) {
        const row = await db.findOne<{ value: string; revision: number }>({ model: 'browsefn_cache', where });
        const entries = deserialize(row?.value); const result = operation(entries); const value = serialize(entries);
        if (row) {
          if (value === row.value) return result;
          if (!Number.isSafeInteger(row.revision) || row.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid BrowseFn cache revision');
          const changed = await db.updateMany({ model: 'browsefn_cache', where: [...where, { field: 'revision', operator: 'eq', value: row.revision }], data: { value, revision: row.revision + 1 } });
          if (changed === 1) return result;
          if (changed > 1) throw new Error('BrowseFn cache database id must be unique');
        } else {
          try { await db.create({ model: 'browsefn_cache', data: { id, value, revision: 1 } }); return result; }
          catch (error) {
            // Adapter implementations vary in duplicate-key error normalization.
            // Retry only when a conflicting id now actually exists.
            if (!await db.findOne({ model: 'browsefn_cache', where })) throw error;
          }
        }
      }
      throw new Error('BrowseFn cache contention: retry the operation');
    } };
  }
  return { async run(operation) {
    const [{ createLocalStorageAdapter }, fs, path, crypto] = await Promise.all([
      import('@superfunctions/storage-local'), import('node:fs/promises'), import('node:path'), import('node:crypto'),
    ]);
    const root = path.resolve(config.directory ?? '.browsefn-cache');
    const filename = crypto.createHash('sha256').update(name).digest('hex') + '.json';
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await fs.realpath(root);
    return serializeOperation(path.join(directory, filename), async () => {
      const lock = path.join(directory, filename + '.lock');
      const deadline = Date.now() + 5000;
      while (true) {
        try { await fs.mkdir(lock); break; }
        catch (e: any) { if (e.code !== 'EEXIST' || Date.now() >= deadline) throw e; await new Promise(r => setTimeout(r, 10)); }
      }
      const adapter = createLocalStorageAdapter({ rootDir: directory });
      const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
      try {
        let raw: string | undefined;
        try { raw = await new Response(await adapter.openDownloadStream!({ key: filename })).text(); }
        catch (e: any) { if (e.code !== 'STORAGE_NOT_FOUND' && e.code !== 'NOT_FOUND' && e.code !== 'ENOENT' && e.status !== 404) throw e; }
        const entries = deserialize(raw); const result = operation(entries);
        const secureFile = await fs.open(path.join(directory, temporary), 'wx', 0o600); await secureFile.close();
        const stream = await adapter.openUploadStream!({ key: temporary }); const writer = stream.getWriter();
        try { await writer.write(new TextEncoder().encode(serialize(entries))); await writer.close(); }
        catch (error) { await writer.abort(error).catch(() => {}); throw error; }
        const durableFile = await fs.open(path.join(directory, temporary), 'r+');
        try { await durableFile.sync(); } finally { await durableFile.close(); }
        await fs.rename(path.join(directory, temporary), path.join(directory, filename));
        return result;
      } finally {
        await fs.unlink(path.join(directory, temporary)).catch(() => {});
        await fs.rmdir(lock);
      }
    });
  } };
}
