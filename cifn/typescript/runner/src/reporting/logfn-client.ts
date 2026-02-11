export interface LogEntry {
  runId: string;
  jobKey: string;
  stepKey: string;
  line: string;
  timestamp: string;
}

export interface LogFnClient {
  append(entry: LogEntry): void;
  appendLines(runId: string, jobKey: string, stepKey: string, lines: string[]): void;
  getLines(runId: string, jobKey: string): LogEntry[];
  getAllLines(runId: string): LogEntry[];
}

export class MemoryLogFnClient implements LogFnClient {
  private entries: LogEntry[] = [];

  append(entry: LogEntry): void {
    this.entries.push(entry);
  }

  appendLines(runId: string, jobKey: string, stepKey: string, lines: string[]): void {
    const now = new Date().toISOString();
    for (const line of lines) {
      this.entries.push({ runId, jobKey, stepKey, line, timestamp: now });
    }
  }

  getLines(runId: string, jobKey: string): LogEntry[] {
    return this.entries.filter(e => e.runId === runId && e.jobKey === jobKey);
  }

  getAllLines(runId: string): LogEntry[] {
    return this.entries.filter(e => e.runId === runId);
  }
}
