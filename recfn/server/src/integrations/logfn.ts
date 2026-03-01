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

export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({
      level: 'info',
      event,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  warn(event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({
      level: 'warn',
      event,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  error(event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({
      level: 'error',
      event,
      data,
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
