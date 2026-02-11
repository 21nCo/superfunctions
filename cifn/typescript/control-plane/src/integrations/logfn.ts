import type { LogsAdapter, LogEvent, JobLogLine } from './types.js';
import type { AdapterConfig } from './config.js';

export class MemoryLogsAdapter implements LogsAdapter {
  private events: LogEvent[] = [];
  private jobLogs = new Map<string, JobLogLine[]>();

  async emitEvent(event: LogEvent): Promise<void> {
    this.events.push(event);
  }

  async appendJobLogLine(runId: string, jobKey: string, line: JobLogLine): Promise<void> {
    const key = `${runId}:${jobKey}`;
    const logs = this.jobLogs.get(key) ?? [];
    logs.push(line);
    this.jobLogs.set(key, logs);
  }

  async appendJobLogLines(runId: string, jobKey: string, lines: JobLogLine[]): Promise<void> {
    const key = `${runId}:${jobKey}`;
    const logs = this.jobLogs.get(key) ?? [];
    logs.push(...lines);
    this.jobLogs.set(key, logs);
  }

  async readJobLogs(runId: string, jobKey: string): Promise<JobLogLine[]> {
    const key = `${runId}:${jobKey}`;
    return [...(this.jobLogs.get(key) ?? [])];
  }

  getEvents(): LogEvent[] {
    return [...this.events];
  }
}

export class LogFnLogsAdapter implements LogsAdapter {
  constructor(private config: { baseUrl: string; apiKey?: string; sink?: string }) {}

  async emitEvent(event: LogEvent): Promise<void> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const sink = this.config.sink ?? 'cifn';
    const response = await fetch(`${this.config.baseUrl}/sinks/${sink}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      throw new Error(`LogFn emitEvent failed: ${response.status} ${response.statusText}`);
    }
  }

  async appendJobLogLine(runId: string, jobKey: string, line: JobLogLine): Promise<void> {
    await this.appendJobLogLines(runId, jobKey, [line]);
  }

  async appendJobLogLines(runId: string, jobKey: string, lines: JobLogLine[]): Promise<void> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const sink = this.config.sink ?? 'cifn';
    const response = await fetch(`${this.config.baseUrl}/sinks/${sink}/logs/${runId}/${jobKey}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lines }),
    });

    if (!response.ok) {
      throw new Error(`LogFn appendJobLogLines failed: ${response.status} ${response.statusText}`);
    }
  }

  async readJobLogs(runId: string, jobKey: string): Promise<JobLogLine[]> {
    const headers: HeadersInit = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const sink = this.config.sink ?? 'cifn';
    const response = await fetch(`${this.config.baseUrl}/sinks/${sink}/logs/${runId}/${jobKey}`, {
      headers,
    });

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new Error(`LogFn readJobLogs failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.lines ?? [];
  }
}

export function createLogsAdapter(config: AdapterConfig['logs']): LogsAdapter {
  if (config.type === 'memory') {
    return new MemoryLogsAdapter();
  }

  if (!config.logfnBaseUrl) {
    throw new Error('LogFn adapter requires baseUrl');
  }

  return new LogFnLogsAdapter({
    baseUrl: config.logfnBaseUrl,
    apiKey: config.logfnApiKey,
    sink: config.logfnSink,
  });
}
