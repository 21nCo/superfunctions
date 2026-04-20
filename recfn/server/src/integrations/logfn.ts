export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /(token|secret|api[_-]?key|authorization|password|clientsecret|accesstoken|refreshtoken)/i;
const TRANSCRIPT_KEY_PATTERN = /(transcript|segments?|chatmessages?|text)$/i;

function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key) || TRANSCRIPT_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }

  if (value && typeof value === 'object') {
    return sanitizeLogData(value as Record<string, unknown>);
  }

  return value;
}

export function sanitizeLogData(data: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
}

export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({
      level: 'info',
      event,
      data: sanitizeLogData(data),
      timestamp: new Date().toISOString(),
    });
  }

  warn(event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({
      level: 'warn',
      event,
      data: sanitizeLogData(data),
      timestamp: new Date().toISOString(),
    });
  }

  error(event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({
      level: 'error',
      event,
      data: sanitizeLogData(data),
      timestamp: new Date().toISOString(),
    });
  }

  findByEvent(event: string): LogEntry[] {
    return this.entries.filter((e) => e.event === event);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export function createNoopLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
