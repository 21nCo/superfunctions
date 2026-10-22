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

/** @deprecated LogFn is a logger/sink library, not the previously assumed HTTP query server. */
export class LogFnLogsAdapter implements LogsAdapter {
  constructor(_config: { baseUrl: string; apiKey?: string; sink?: string }) {
    throw new Error('Standalone LogFn HTTP adapter is unsupported: use durable CiFn remote log delivery (SQLite store); external forwarding requires an actual LogFn sink/receiver');
  }
  async emitEvent(_event: LogEvent): Promise<void> { throw new Error('Unsupported standalone LogFn adapter'); }
  async appendJobLogLine(_runId: string, _jobKey: string, _line: JobLogLine): Promise<void> { throw new Error('Unsupported standalone LogFn adapter'); }
  async appendJobLogLines(_runId: string, _jobKey: string, _lines: JobLogLine[]): Promise<void> { throw new Error('Unsupported standalone LogFn adapter'); }
  async readJobLogs(_runId: string, _jobKey: string): Promise<JobLogLine[]> { throw new Error('Unsupported standalone LogFn adapter'); }
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
