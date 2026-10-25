import type { LogEvent } from '../types.js';

interface QueuedEvent { id?: number; queue: string; event: LogEvent }

/** Transactional, at-least-once browser queue. Acknowledgements remove exact IDs. */
export class IndexedDbQueue {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly key: string, private readonly limit: number) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('logfn-http-queue', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        store.createIndex('queue', 'queue');
      };
      request.onerror = () => reject(request.error);
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error('LogFn IndexedDB queue is blocked')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.database = undefined; };
        resolve(db);
      };
    }).catch(error => { this.database = undefined; throw error; });
    return this.database;
  }

  async add(events: LogEvent[]): Promise<number> {
    const db = await this.open();
    return new Promise<number>((resolve, reject) => {
      let evicted = 0;
      const tx = db.transaction('events', 'readwrite');
      tx.oncomplete = () => resolve(evicted);
      tx.onabort = () => reject(tx.error ?? new Error('LogFn queue write aborted'));
      tx.onerror = () => {};
      try {
        const store = tx.objectStore('events');
        for (const event of events) store.add({ queue: this.key, event });
        const keys = store.index('queue').getAllKeys(this.key);
        keys.onsuccess = () => {
          evicted = Math.max(0, keys.result.length - this.limit);
          for (const key of keys.result.slice(0, evicted)) store.delete(key);
        };
      } catch (error) { tx.abort(); reject(error); }
    });
  }

  async batch(limit: number): Promise<QueuedEvent[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readonly');
      const request = tx.objectStore('events').index('queue').getAll(this.key, limit);
      tx.oncomplete = () => resolve(request.result as QueuedEvent[]);
      tx.onabort = () => reject(tx.error ?? new Error('LogFn queue read aborted'));
      tx.onerror = () => {};
    });
  }

  async acknowledge(events: QueuedEvent[]): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('LogFn queue acknowledgement aborted'));
      tx.onerror = () => {};
      for (const event of events) tx.objectStore('events').delete(event.id!);
    });
  }

  async close(): Promise<void> {
    if (this.database) (await this.database).close();
    this.database = undefined;
  }
}
