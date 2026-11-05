import type { StorageAdapter, StorageQuery, StoredEvent } from "../types.js";
import { matchesQuery, storedTimestampMs } from "../validation.js";

export interface MemoryStorageOptions {
  /** Keep at most this many events; the oldest are evicted first. Defaults to 10 000. */
  maxEvents?: number;
}

interface Entry {
  seq: number;
  timestampMs: number;
  event: StoredEvent;
}

export interface MemoryStorage extends StorageAdapter {
  readonly kind: "memory";
  readonly durable: false;
  /** Number of events currently held. */
  size(): number;
}

/**
 * In-process storage for tests and local development. Events live as long as
 * this object, survive `close()`/`open()` and are lost with the process.
 */
export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const maxEvents = options.maxEvents ?? 10_000;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError("createMemoryStorage: maxEvents must be a positive integer");
  }
  let entries: Entry[] = [];
  const ids = new Set<string>();
  let seq = 0;

  return {
    kind: "memory",
    durable: false,
    async write(events) {
      // A larger batch would evict part of itself, so its receipt would claim events that are gone.
      if (events.length > maxEvents) {
        throw new RangeError(`memory storage: a write of ${events.length} events exceeds maxEvents (${maxEvents})`);
      }
      // Check and copy everything before mutating, so a rejected batch leaves storage unchanged.
      const batchIds = new Set<string>();
      const added = events.map((event) => {
        const timestampMs = storedTimestampMs(event.timestamp, "timestamp", "memory");
        storedTimestampMs(event.receivedAt, "receivedAt", "memory");
        if (ids.has(event.id) || batchIds.has(event.id)) throw new Error(`memory storage: duplicate event id ${event.id}`);
        batchIds.add(event.id);
        return { seq: 0, timestampMs, event: structuredClone(event) };
      });
      for (const entry of added) {
        seq += 1;
        entry.seq = seq;
        entries.push(entry);
        ids.add(entry.event.id);
      }
      if (entries.length > maxEvents) {
        for (const evicted of entries.slice(0, entries.length - maxEvents)) ids.delete(evicted.event.id);
        entries = entries.slice(entries.length - maxEvents);
      }
    },
    async query(query: StorageQuery) {
      const direction = query.order === "asc" ? 1 : -1;
      return entries
        .filter((entry) => matchesQuery({ ...entry.event, timestampMs: entry.timestampMs }, query))
        .sort((a, b) => direction * (a.timestampMs - b.timestampMs || a.seq - b.seq))
        .slice(0, query.limit)
        .map((entry) => structuredClone(entry.event));
    },
    size() {
      return entries.length;
    },
  };
}
