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

function encodeQueueName(queueName: string): string {
  const normalized = queueName.trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new Error('FLOWFN_QUEUE_NAME_INVALID');
  }
  return encodeURIComponent(normalized);
}

export class FlowFnQueueAdapter<TPayload> implements QueueAdapter<TPayload> {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly config: FlowFnQueueAdapterConfig) {
    this.fetcher = config.fetch ?? globalThis.fetch;
  }

  async enqueue(queueName: string, payload: TPayload): Promise<void> {
    const encodedQueueName = encodeQueueName(queueName);
    const response = await this.fetcher(`${this.config.baseUrl}/queues/${encodedQueueName}/enqueue`, {
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
    const encodedQueueName = encodeQueueName(queueName);
    const response = await this.fetcher(`${this.config.baseUrl}/queues/${encodedQueueName}/dequeue`, {
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
    void matcher;
    encodeQueueName(queueName);
    throw new Error('FLOWFN_QUEUE_MATCHING_UNSUPPORTED');
  }

  peek(queueName: string): TPayload[] {
    encodeQueueName(queueName);
    throw new Error('FLOWFN_QUEUE_PEEK_UNSUPPORTED');
  }

  size(queueName: string): number {
    encodeQueueName(queueName);
    throw new Error('FLOWFN_QUEUE_SIZE_UNSUPPORTED');
  }
}
