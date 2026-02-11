import type { JobSpec } from '../pipeline/types.js';

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

export class MemoryQueueClient implements QueueClient {
  private queues = new Map<string, JobPayload[]>();

  async enqueue(queueName: string, payload: JobPayload): Promise<void> {
    const queue = this.queues.get(queueName) ?? [];
    queue.push(payload);
    this.queues.set(queueName, queue);
  }

  async dequeue(queueName: string): Promise<JobPayload | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }

  async dequeueMatching(queueName: string, matcher: (payload: JobPayload) => boolean): Promise<JobPayload | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) return null;
    const index = queue.findIndex(matcher);
    if (index === -1) return null;
    const [payload] = queue.splice(index, 1);
    return payload ?? null;
  }

  peek(queueName: string): JobPayload[] {
    return [...(this.queues.get(queueName) ?? [])];
  }

  size(queueName: string): number {
    return this.queues.get(queueName)?.length ?? 0;
  }
}

export const DEFAULT_QUEUE_NAME = 'cifn:jobs';
