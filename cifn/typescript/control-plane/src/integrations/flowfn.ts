import type { QueueAdapter } from './types.js';
import type { JobPayload } from '../queue/flowfn-client.js';
import type { AdapterConfig } from './config.js';

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

export class FlowFnQueueAdapter implements QueueAdapter {
  constructor(private config: { baseUrl: string; apiKey: string }) {}

  async enqueue(queueName: string, payload: JobPayload): Promise<void> {
    const response = await fetch(`${this.config.baseUrl}/queues/${queueName}/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`FlowFn enqueue failed: ${response.status} ${response.statusText}`);
    }
  }

  async dequeue(queueName: string): Promise<JobPayload | null> {
    const response = await fetch(`${this.config.baseUrl}/queues/${queueName}/dequeue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`FlowFn dequeue failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { payload?: JobPayload };
    return data.payload ?? null;
  }

  async dequeueMatching(queueName: string, matcher: (payload: JobPayload) => boolean): Promise<JobPayload | null> {
    const response = await fetch(`${this.config.baseUrl}/queues/${queueName}/peek`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`FlowFn peek failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { payloads?: JobPayload[] };
    const payloads = data.payloads ?? [];
    
    for (const payload of payloads) {
      if (matcher(payload)) {
        const claimResponse = await fetch(`${this.config.baseUrl}/queues/${queueName}/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({ matcher: 'implementation-defined' }),
        });

        if (claimResponse.ok) {
          return payload;
        }
      }
    }

    return null;
  }

  peek(queueName: string): JobPayload[] {
    return [];
  }

  size(queueName: string): number {
    return 0;
  }
}

export function createQueueAdapter(config: AdapterConfig['queue']): QueueAdapter {
  if (config.type === 'memory') {
    return new MemoryQueueAdapter();
  }

  if (!config.flowfnBaseUrl || !config.flowfnApiKey) {
    throw new Error('FlowFn adapter requires baseUrl and apiKey');
  }

  return new FlowFnQueueAdapter({
    baseUrl: config.flowfnBaseUrl,
    apiKey: config.flowfnApiKey,
  });
}
