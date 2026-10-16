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
  private readonly secrets = new Map<string, number>();
  registerSecrets(value: unknown): () => void {
    const found = new Set<string>();
    const seen = new WeakSet<object>();
    const visit = (item: unknown): void => {
      if (!item || typeof item !== 'object' || seen.has(item)) return;
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase()) && typeof child === 'string' && child) found.add(child);
        if (key === 'cookies' && Array.isArray(child)) for (const cookie of child) if (typeof cookie.value === 'string' && cookie.value) found.add(cookie.value);
        visit(child);
      }
    };
    visit(value);
    for (const secret of found) this.secrets.set(secret, (this.secrets.get(secret) ?? 0) + 1);
    return () => { for (const secret of found) { const count = this.secrets.get(secret)! - 1; if (count) this.secrets.set(secret, count); else this.secrets.delete(secret); } };
  }
  private redactSecrets(value: unknown): unknown {
    if (typeof value === 'string') { value = value.replace(/https?:\/\/[^\s\"'<>]+/g, url => Logger.redactUrl(url)); for (const secret of this.secrets.keys()) value = (value as string).split(secret).join('[REDACTED]'); return value; }
    if (Array.isArray(value)) return value.map(item => this.redactSecrets(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactSecrets(item)]));
    return value;
  }

  log(event: BrowseFnEvent, data: Omit<EventData, 'event' | 'timestamp'>): EventData {
    const entry = Logger.sanitizeEventData({
      ...data,
      event,
      timestamp: Date.now(),
    });

    const safeEntry = this.redactSecrets(entry) as EventData;
    this.logs.push(safeEntry);
    if (this.logs.length > 1000) {
      this.logs.shift();
    }

    return safeEntry;
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

  static hasUrlCredentials(input: string): boolean {
    try { const url = new URL(input); return !!(url.username || url.password) || [...url.searchParams.keys()].some(key => SENSITIVE_QUERY_KEYS.has(key.toLowerCase())); } catch { return false; }
  }

  private static redactUrl(input: string): string {
    try {
      const url = new URL(input);
      if (url.username) url.username = '[REDACTED]';
      if (url.password) url.password = '[REDACTED]';
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
