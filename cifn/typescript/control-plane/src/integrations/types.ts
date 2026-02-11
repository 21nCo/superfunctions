import type { JobPayload } from '../queue/flowfn-client.js';

export interface QueueAdapter {
  enqueue(queueName: string, payload: JobPayload): Promise<void>;
  dequeue(queueName: string): Promise<JobPayload | null>;
  dequeueMatching(queueName: string, matcher: (payload: JobPayload) => boolean): Promise<JobPayload | null>;
  peek(queueName: string): JobPayload[];
  size(queueName: string): number;
}

export interface ArtifactsAdapter {
  upload(namespace: string, key: string, data: Buffer): Promise<string>;
  download(fileId: string): Promise<Buffer | null>;
  downloadByKey(namespace: string, key: string): Promise<Buffer | null>;
  getFileId(namespace: string, key: string): string | null;
  list(namespace: string): Array<{ fileId: string; namespace: string; key: string; createdAt: string }>;
  getSignedUrl?(fileId: string, expiresIn?: number): Promise<string | null>;
}

export interface SecretsAdapter {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  listKeys(): Promise<string[]>;
  validateToken(token: string, expectedKey?: string): Promise<boolean>;
}

export interface LogEvent {
  timestamp: string;
  eventType: 'run.created' | 'run.status_changed' | 'job.started' | 'job.completed' | 'step.started' | 'step.completed' | 'runner.registered' | 'runner.heartbeat' | 'webhook.verified' | 'webhook.rejected';
  runId?: string;
  jobKey?: string;
  stepKey?: string;
  runnerId?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface JobLogLine {
  line: string;
  timestamp: string;
  stepKey: string;
}

export interface LogsAdapter {
  emitEvent(event: LogEvent): Promise<void>;
  appendJobLogLine(runId: string, jobKey: string, line: JobLogLine): Promise<void>;
  appendJobLogLines(runId: string, jobKey: string, lines: JobLogLine[]): Promise<void>;
  readJobLogs(runId: string, jobKey: string): Promise<JobLogLine[]>;
}

export type AdapterType = 'memory' | 'real';

export interface IntegrationAdapters {
  queue: QueueAdapter;
  artifacts: ArtifactsAdapter;
  secrets: SecretsAdapter;
  logs: LogsAdapter;
}
