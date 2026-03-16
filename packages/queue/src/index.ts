export interface QueueAdapter<TPayload> {
  enqueue(queueName: string, payload: TPayload): Promise<void>;
  dequeue(queueName: string): Promise<TPayload | null>;
  dequeueMatching(queueName: string, matcher: (payload: TPayload) => boolean): Promise<TPayload | null>;
  peek(queueName: string): TPayload[];
  size(queueName: string): number;
}

export class MemoryQueueAdapter<TPayload> implements QueueAdapter<TPayload> {
  private readonly queues = new Map<string, TPayload[]>();

  async enqueue(queueName: string, payload: TPayload): Promise<void> {
    const queue = this.queues.get(queueName) ?? [];
    queue.push(payload);
    this.queues.set(queueName, queue);
  }

  async dequeue(queueName: string): Promise<TPayload | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) {
      return null;
    }

    return queue.shift() ?? null;
  }

  async dequeueMatching(queueName: string, matcher: (payload: TPayload) => boolean): Promise<TPayload | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) {
      return null;
    }

    const index = queue.findIndex(matcher);
    if (index === -1) {
      return null;
    }

    const [payload] = queue.splice(index, 1);
    return payload ?? null;
  }

  peek(queueName: string): TPayload[] {
    return [...(this.queues.get(queueName) ?? [])];
  }

  size(queueName: string): number {
    return this.queues.get(queueName)?.length ?? 0;
  }
}

export interface FlowFnQueueAdapterConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export class FlowFnQueueAdapter<TPayload> implements QueueAdapter<TPayload> {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly config: FlowFnQueueAdapterConfig) {
    this.fetcher = config.fetch ?? globalThis.fetch;
  }

  async enqueue(queueName: string, payload: TPayload): Promise<void> {
    const response = await this.fetcher(`${this.config.baseUrl}/queues/${queueName}/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`FlowFn enqueue failed: ${response.status} ${response.statusText}`);
    }
  }

  async dequeue(queueName: string): Promise<TPayload | null> {
    const response = await this.fetcher(`${this.config.baseUrl}/queues/${queueName}/dequeue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`FlowFn dequeue failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { payload?: TPayload };
    return data.payload ?? null;
  }

  async dequeueMatching(queueName: string, matcher: (payload: TPayload) => boolean): Promise<TPayload | null> {
    const queued = this.peek(queueName);
    for (const payload of queued) {
      if (matcher(payload)) {
        const claimed = await this.dequeue(queueName);
        if (claimed) {
          return claimed;
        }
      }
    }

    return null;
  }

  peek(_queueName: string): TPayload[] {
    return [];
  }

  size(_queueName: string): number {
    return 0;
  }
}
