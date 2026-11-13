/**
 * A fixed-capacity buffer that keeps the newest entries, plus the time-window
 * query the collectors expose as `collect({ since, until })`.
 */

/** Inclusive time window in milliseconds since the Unix epoch. */
export interface CollectWindow {
  /** Keep entries with `timestamp >= since`. */
  since?: number;
  /** Keep entries with `timestamp <= until`. */
  until?: number;
}

export function assertCapacity(capacity: number, name = "maxSize"): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError(`${name} must be a nonnegative integer`);
}

function bound(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) throw new RangeError(`${name} must be a number of milliseconds`);
  return value;
}

export class RingBuffer<T extends { timestamp: number }> {
  private readonly slots: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    assertCapacity(capacity, "capacity");
    this.slots = new Array<T | undefined>(capacity);
  }

  /** Append an entry, evicting the oldest one when the buffer is full. */
  push(entry: T): void {
    if (this.capacity === 0) return;
    if (this.count < this.capacity) {
      this.slots[(this.start + this.count) % this.capacity] = entry;
      this.count += 1;
      return;
    }
    this.slots[this.start] = entry;
    this.start = (this.start + 1) % this.capacity;
  }

  /** Entries in insertion order, oldest first. */
  toArray(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.count; index += 1) result.push(this.slots[(this.start + index) % this.capacity] as T);
    return result;
  }

  /**
   * Entries whose timestamp lies in the inclusive window, in insertion order.
   * Either bound may be omitted; an empty window (`since > until`) matches
   * nothing. Entries are filtered rather than searched, so a wall clock that
   * stepped backwards cannot hide an entry.
   */
  query(window: CollectWindow = {}): T[] {
    const since = bound(window.since, "since");
    const until = bound(window.until, "until");
    return this.toArray().filter(
      (entry) => (since === undefined || entry.timestamp >= since) && (until === undefined || entry.timestamp <= until)
    );
  }

  clear(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
