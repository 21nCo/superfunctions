/**
 * Logging middleware
 */

import type { EventData } from '../core/types.js';

export class Logger {
  private logs: EventData[] = [];

  /**
   * Log an event
   */
  log(event: string, data: Omit<EventData, 'timestamp'>): void {
    const entry: EventData = {
      ...data,
      timestamp: Date.now()
    };

    this.logs.push(entry);

    // Keep only last 1000 logs
    if (this.logs.length > 1000) {
      this.logs.shift();
    }
  }

  /**
   * Get logs
   */
  getLogs(filter?: { event?: string; provider?: string; since?: number }): EventData[] {
    let filtered = [...this.logs];

    if (filter?.since) {
      filtered = filtered.filter(log => log.timestamp >= filter.since);
    }

    if (filter?.provider) {
      filtered = filtered.filter(log => log.provider === filter.provider);
    }

    return filtered;
  }

  /**
   * Clear logs
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Get log count
   */
  count(): number {
    return this.logs.length;
  }
}
