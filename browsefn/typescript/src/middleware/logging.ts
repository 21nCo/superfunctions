/**
 * Logging middleware.
 */

import type { BrowseFnEvent, EventData } from '../core/types.js';

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'client_id',
  'key',
  'password',
  'secret',
  'signature',
  'token',
]);

const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'cookie',
  'client_id',
  'api_key',
  'apikey',
  'password',
  'secret',
  'token',
]);

export class Logger {
  private logs: EventData[] = [];

  log(event: BrowseFnEvent, data: Omit<EventData, 'event' | 'timestamp'>): EventData {
    const entry = Logger.sanitizeEventData({
      ...data,
      event,
      timestamp: Date.now(),
    });

    this.logs.push(entry);
    if (this.logs.length > 1000) {
      this.logs.shift();
    }

    return entry;
  }

  getLogs(filter?: { event?: BrowseFnEvent; provider?: string; since?: number }): EventData[] {
    let filtered = [...this.logs];
    const since = filter?.since;

    if (typeof since === 'number') {
      filtered = filtered.filter((log) => log.timestamp >= since);
    }

    if (filter?.event) {
      filtered = filtered.filter((log) => log.event === filter.event);
    }

    if (filter?.provider) {
      filtered = filtered.filter((log) => log.provider === filter.provider);
    }

    return filtered;
  }

  clear(): void {
    this.logs = [];
  }

  count(): number {
    return this.logs.length;
  }

  private static sanitizeEventData(entry: EventData): EventData {
    return {
      ...entry,
      url: entry.url ? Logger.redactUrl(entry.url) : undefined,
      details: entry.details ? (Logger.redactValue(entry.details) as Record<string, unknown>) : undefined,
    };
  }

  private static redactUrl(input: string): string {
    try {
      const url = new URL(input);
      for (const key of url.searchParams.keys()) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
          url.searchParams.set(key, '[REDACTED]');
        }
      }
      return url.toString();
    } catch {
      return input;
    }
  }

  private static redactValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => Logger.redactValue(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, rawValue]) => {
        if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
          return [key, '[REDACTED]'];
        }

        if (typeof rawValue === 'string' && key.toLowerCase() === 'url') {
          return [key, Logger.redactUrl(rawValue)];
        }

        return [key, Logger.redactValue(rawValue)];
      })
    );
  }
}
