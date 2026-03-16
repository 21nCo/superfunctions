import type { JobSpec } from '../pipeline/types.js';
import { MemoryQueueAdapter as SharedMemoryQueueAdapter } from '@superfunctions/queue';

export interface JobPayload {
  runId: string;
  jobKey: string;
  jobSpec: JobSpec;
  pipelineRef?: { repo: string; ref: string; configPath?: string };
  env?: Record<string, string>;
  secretKeys?: string[];
}

export interface QueueClient {
  enqueue(queueName: string, payload: JobPayload): Promise<void>;
  dequeue(queueName: string): Promise<JobPayload | null>;
  dequeueMatching(queueName: string, matcher: (payload: JobPayload) => boolean): Promise<JobPayload | null>;
  peek(queueName: string): JobPayload[];
  size(queueName: string): number;
}

export class MemoryQueueClient extends SharedMemoryQueueAdapter<JobPayload> implements QueueClient {}

export const DEFAULT_QUEUE_NAME = 'cifn:jobs';
