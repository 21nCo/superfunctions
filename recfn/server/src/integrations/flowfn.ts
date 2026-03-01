export interface JobPayload {
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface QueueAdapter {
  enqueue(queueName: string, payload: JobPayload): Promise<void>;
  dequeue(queueName: string): Promise<JobPayload | null>;
  peek(queueName: string): JobPayload[];
  size(queueName: string): number;
}

export class MemoryQueueAdapter implements QueueAdapter {
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

  peek(queueName: string): JobPayload[] {
    return [...(this.queues.get(queueName) ?? [])];
  }

  size(queueName: string): number {
    return this.queues.get(queueName)?.length ?? 0;
  }
}

export const QUEUE_NAMES = {
  BOT_JOIN: 'recfn.bot.join',
  RECORDING_UPLOAD: 'recfn.recording.upload',
  TRANSCRIPTION: 'recfn.transcription',
} as const;
