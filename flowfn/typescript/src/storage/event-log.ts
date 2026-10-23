/**
 * Event log for event sourcing pattern
 */

export interface Event {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  data: any;
  metadata?: Record<string, any>;
  timestamp: number;
  version: number;
}

export interface EventFilter {
  aggregateId?: string;
  aggregateType?: string;
  types?: string[];
  fromVersion?: number;
  toVersion?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  offset?: number;
}

export interface EventLog {
  /**
   * Append event to the log
   */
  append(event: Omit<Event, "id" | "timestamp" | "version">): Promise<Event>;

  /**
   * Get events by filter
   */
  getEvents(filter: EventFilter): Promise<Event[]>;

  /**
   * Get events for an aggregate
   */
  getAggregateEvents(
    aggregateId: string,
    fromVersion?: number
  ): Promise<Event[]>;

  /**
   * Get latest version for an aggregate
   */
  getLatestVersion(aggregateId: string): Promise<number>;

  /**
   * Subscribe to event stream
   */
  subscribe(
    handler: (event: Event) => void | Promise<void>,
    filter?: EventFilter
  ): () => void;
}

/**
 * In-memory event log implementation
 */
export class MemoryEventLog implements EventLog {
  private events: Event[] = [];
  private aggregateVersions: Map<string, number> = new Map();
  private subscribers: Array<{
    handler: (event: Event) => void | Promise<void>;
    filter?: EventFilter;
  }> = [];

  async append(
    event: Omit<Event, "id" | "timestamp" | "version">
  ): Promise<Event> {
    const version = (this.aggregateVersions.get(event.aggregateId) || 0) + 1;
    this.aggregateVersions.set(event.aggregateId, version);

    const fullEvent: Event = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      timestamp: Date.now(),
      version,
    };

    this.events.push(fullEvent);

    // Notify subscribers
    for (const subscriber of this.subscribers) {
      if (this.matchesFilter(fullEvent, subscriber.filter)) {
        Promise.resolve(subscriber.handler(fullEvent)).catch((err) =>
          console.error("Event subscriber error:", err)
        );
      }
    }

    return fullEvent;
  }

  async getEvents(filter: EventFilter): Promise<Event[]> {
    let results = [...this.events];

    // Apply filters
    if (filter.aggregateId) {
      results = results.filter((e) => e.aggregateId === filter.aggregateId);
    }

    if (filter.aggregateType) {
      results = results.filter((e) => e.aggregateType === filter.aggregateType);
    }

    if (filter.types && filter.types.length > 0) {
      results = results.filter((e) => filter.types!.includes(e.type));
    }

    if (filter.fromVersion !== undefined) {
      results = results.filter((e) => e.version >= filter.fromVersion!);
    }

    if (filter.toVersion !== undefined) {
      results = results.filter((e) => e.version <= filter.toVersion!);
    }

    if (filter.fromTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.fromTimestamp!);
    }

    if (filter.toTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp <= filter.toTimestamp!);
    }

    // Sort by version
    results.sort((a, b) => a.version - b.version);

    // Pagination
    const offset = filter.offset || 0;
    const limit = filter.limit || results.length;

    return results.slice(offset, offset + limit);
  }

  async getAggregateEvents(
    aggregateId: string,
    fromVersion?: number
  ): Promise<Event[]> {
    return this.getEvents({
      aggregateId,
      fromVersion,
    });
  }

  async getLatestVersion(aggregateId: string): Promise<number> {
    return this.aggregateVersions.get(aggregateId) || 0;
  }

  subscribe(
    handler: (event: Event) => void | Promise<void>,
    filter?: EventFilter
  ): () => void {
    const subscriber = { handler, filter };
    this.subscribers.push(subscriber);

    // Return unsubscribe function
    return () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index > -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  private matchesFilter(event: Event, filter?: EventFilter): boolean {
    if (!filter) return true;

    if (filter.aggregateId && event.aggregateId !== filter.aggregateId)
      return false;
    if (filter.aggregateType && event.aggregateType !== filter.aggregateType)
      return false;
    if (filter.types && !filter.types.includes(event.type)) return false;
    if (filter.fromVersion !== undefined && event.version < filter.fromVersion)
      return false;
    if (filter.toVersion !== undefined && event.version > filter.toVersion)
      return false;
    if (
      filter.fromTimestamp !== undefined &&
      event.timestamp < filter.fromTimestamp
    )
      return false;
    if (
      filter.toTimestamp !== undefined &&
      event.timestamp > filter.toTimestamp
    )
      return false;

    return true;
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events = [];
    this.aggregateVersions.clear();
    this.subscribers = [];
  }
}
