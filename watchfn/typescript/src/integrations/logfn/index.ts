import { defaultRedactor, type LogEvent, type Sink } from '@logfn/core';

export interface LogFnSource { addSink(sink: Sink): () => void }
export interface LogFnIntegrationOptions {
  enabled?: boolean;
  autoIngest?: boolean;
  parseStructured?: boolean;
  indexFields?: string[];
  minLevel?: LogEvent['level'];
}
export type ResolvedLogFnOptions = Required<LogFnIntegrationOptions>;
const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const redact = defaultRedactor();
export function resolveLogFnOptions(config: unknown, explicit: unknown): ResolvedLogFnOptions {
  const value: Record<string, unknown> = {};
  for (const input of [config, explicit]) {
    if (input === undefined) continue;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid LogFn integration options');
    for (const [key, item] of Object.entries(input)) {
      if (!['enabled', 'autoIngest', 'parseStructured', 'indexFields', 'minLevel'].includes(key)) throw new TypeError('Unknown LogFn integration option');
      value[key] = item;
    }
  }
  for (const key of ['enabled', 'autoIngest', 'parseStructured']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError('Invalid LogFn integration boolean');
  if (value.minLevel !== undefined && !levels.includes(value.minLevel as string)) throw new TypeError('Invalid LogFn minimum level');
  const fields = value.indexFields ?? ['level', 'service', 'userId', 'traceId'];
  if (!Array.isArray(fields) || fields.length > 32 || fields.some(field => typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field) || field.length > 128 || field.split('.').some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part)))) throw new TypeError('Invalid LogFn index fields');
  return { enabled: value.enabled !== false, autoIngest: value.autoIngest !== false, parseStructured: value.parseStructured !== false,
    minLevel: (value.minLevel ?? 'trace') as LogEvent['level'], indexFields: [...new Set(fields)].sort() };
}

/** Input is already terminal-redacted by LogFn. Only newly decoded JSON gets a new privacy pass. */
export function normalizeLogBatch(batch: LogEvent[], options: ResolvedLogFnOptions, appName?: string): Record<string, unknown>[] {
  if (!Array.isArray(batch) || batch.length > 1000) throw new TypeError('Invalid LogFn batch');
  const result: Record<string, unknown>[] = [];
  let totalBytes = 0, normalizedBytes = 0;
  for (const input of batch) {
    if (!input || typeof input !== 'object' || !levels.includes(input.level) || typeof input.ts !== 'string' || !Number.isFinite(Date.parse(input.ts)) || typeof input.msg !== 'string' || typeof input.name !== 'string') throw new TypeError('Invalid LogFn event');
    if (input.ctx != null && (typeof input.ctx !== 'object' || Array.isArray(input.ctx))) throw new TypeError('Invalid LogFn context');
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input.ts)) throw new TypeError('LogFn timestamp requires a timezone');
    if (levels.indexOf(input.level) < levels.indexOf(options.minLevel)) continue;
    // Detach even custom producer callbacks from storage-owned values.
    const encoded = JSON.stringify(input);
    const size = Buffer.byteLength(encoded, 'utf8'); totalBytes += size;
    if (totalBytes > 16 * 1024 * 1024) throw new TypeError('LogFn batch exceeds 16MiB');
    if (size > 65536) throw new TypeError('LogFn event exceeds 64KiB');
    const event = JSON.parse(encoded) as LogEvent;
    let structured: Record<string, unknown> = {};
    let message = event.msg;
    if (options.parseStructured && event.msg.trimStart().startsWith('{')) {
      try {
        const decoded = JSON.parse(event.msg);
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
          structured = redact(decoded) as Record<string, unknown>;
          message = JSON.stringify(structured);
        }
      } catch { /* Malformed structured text remains ordinary terminal-redacted text. */ }
    }
    const context = { ...structured, ...(event.ctx ?? {}) };
    const service = typeof context.service === 'string' ? context.service : event.name;
    const normalized = { ...context, ...event, type: 'log', name: event.name, timestamp: event.ts, message, msg: message,
      level: event.level, service, properties: { ...context, level: event.level, message, service }, ctx: event.ctx ?? {}, ...(appName === undefined ? {} : {app: {name: appName}}) };
    const normalizedSize = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    normalizedBytes += normalizedSize;
    if (normalizedSize > 65536) throw new TypeError('Normalized LogFn event exceeds 64KiB');
    if (normalizedBytes > 16 * 1024 * 1024) throw new TypeError('Normalized LogFn batch exceeds 16MiB');
    result.push(normalized);
  }
  return result;
}
