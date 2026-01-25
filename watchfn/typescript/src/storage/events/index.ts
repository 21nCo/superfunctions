import { DataCompressor } from "../../utils/compression";

export interface StoredEvent {
  id: string;
  type: string;
  timestamp: number;
  data: any;
  tags?: Record<string, string>;
  indexed: boolean;
}

export interface EventIndex {
  field: string;
  values: Map<any, Set<string>>; // value -> event IDs
}

export class EventStore {
  private events: Map<string, StoredEvent> = new Map();
  private indexes: Map<string, EventIndex> = new Map();
  private indexedFields: Set<string>; = new Set();

  constructor(indexFields: string[] = []) {
    indexFields.forEach((field) => this.createIndex(field));
  }

  /**
   * Store an event
   */
  async store(event: Omit<StoredEvent, "indexed">): Promise<string> {
    const id = event.id || this.generateId();
    const storedEvent: StoredEvent = {
      ...event,
      id,
      indexed: false,
    };

    this.events.set(id, storedEvent);
    await this.indexEvent(storedEvent);

    return id;
  }

  /**
   * Store multiple events in batch
   */
  async storeBatch(events: Omit<StoredEvent, "indexed">[]): Promise<string[]> {
    const ids: string[] = [];

    for (const event of events) {
      const id = await this.store(event);
      ids.push(id);
    }

    return ids;
  }

  /**
   * Get an event by ID
   */
  get(id: string): StoredEvent | undefined {
    return this.events.get(id);
  }

  /**
   * Query events
   */
  query(options: {
    type?: string;
    from?: number;
    to?: number;
    tags?: Record<string, string>;
    limit?: number;
    offset?: number;
  }): StoredEvent[] {
    let results: StoredEvent[] = Array.from(this.events.values());

    // Filter by type
    if (options.type) {
      results = results.filter((e) => e.type === options.type);
    }

    // Filter by time range
    if (options.from !== undefined) {
      results = results.filter((e) => e.timestamp >= options.from!);
    }
    if (options.to !== undefined) {
      results = results.filter((e) => e.timestamp <= options.to!);
    }

    // Filter by tags
    if (options.tags) {
      results = results.filter((e) => {
        if (!e.tags) return false;
        return Object.entries(options.tags!).every(([key, value]) => e.tags![key] === value);
      });
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * Query using indexed fields (faster)
   */
  queryIndexed(field: string, value: any): StoredEvent[] {
    const index = this.indexes.get(field);
    if (!index) {
      throw new Error(`No index exists for field: ${field}`);
    }

    const eventIds = index.values.get(value);
    if (!eventIds) {
      return [];
    }

    return Array.from(eventIds)
      .map((id) => this.events.get(id))
      .filter((e): e is StoredEvent => e !== undefined);
  }

  /**
   * Delete events older than a timestamp
   */
  deleteOlderThan(timestamp: number): number {
    let deleted = 0;

    for (const [id, event] of this.events) {
      if (event.timestamp < timestamp) {
        this.unindexEvent(event);
        this.events.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Create an index for a field
   */
  createIndex(field: string): void {
    if (this.indexes.has(field)) {
      return;
    }

    const index: EventIndex = {
      field,
      values: new Map(),
    };

    this.indexes.set(field, index);
    this.indexedFields.add(field);

    // Index existing events
    for (const event of this.events.values()) {
      if (!event.indexed) {
        this.indexEventField(event, field);
      }
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalEvents: number;
    indexedEvents: number;
    indexes: number;
    averageEventSize: number;
  } {
    const indexed = Array.from(this.events.values()).filter((e) => e.indexed).length;

    let totalSize = 0;
    for (const event of this.events.values()) {
      totalSize += JSON.stringify(event).length;
    }

    return {
      totalEvents: this.events.size,
      indexedEvents: indexed,
      indexes: this.indexes.size,
      averageEventSize: this.events.size > 0 ? totalSize / this.events.size : 0,
    };
  }

  private async indexEvent(event: StoredEvent): Promise<void> {
    for (const field of this.indexedFields) {
      this.indexEventField(event, field);
    }
    event.indexed = true;
  }

  private indexEventField(event: StoredEvent, field: string): void {
    const index = this.indexes.get(field);
    if (!index) return;

    const value = this.getFieldValue(event, field);
    if (value === undefined) return;

    if (!index.values.has(value)) {
      index.values.set(value, new Set());
    }

    index.values.get(value)!.add(event.id);
  }

  private unindexEvent(event: StoredEvent): void {
    for (const [field, index] of this.indexes) {
      const value = this.getFieldValue(event, field);
      if (value !== undefined) {
        const eventIds = index.values.get(value);
        if (eventIds) {
          eventIds.delete(event.id);
          if (eventIds.size === 0) {
            index.values.delete(value);
          }
        }
      }
    }
  }

  private getFieldValue(event: StoredEvent, field: string): any {
    const parts = field.split(".");
    let value: any = event;

    for (const part of parts) {
      if (value === undefined || value === null) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  private generateId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
