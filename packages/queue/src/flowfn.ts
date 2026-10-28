import { QueueError, normalizeQueueName } from './validation.js';

export interface FlowFnQueueAdapterConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl;
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function encodeQueueName(queueName: string): string {
  return encodeURIComponent(normalizeQueueName(queueName));
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return 15_000;
  }
  if (!Number.isFinite(value)) {
    throw new QueueError('FLOWFN_QUEUE_TIMEOUT_INVALID');
  }
  return Math.max(0, value);
}

/**
 * HTTP client for a hosted FlowFn queue. The FlowFn API only offers enqueue
 * and a destructive dequeue, without leases, acknowledgements or retries, so
 * this client does not implement `QueueAdapter`.
 */
export class FlowFnQueueAdapter<TPayload> {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly config: FlowFnQueueAdapterConfig) {
    this.fetcher = config.fetch ?? globalThis.fetch;
    this.timeoutMs = normalizeTimeoutMs(config.timeoutMs);
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  async enqueue(queueName: string, payload: TPayload): Promise<void> {
    const encodedQueueName = encodeQueueName(queueName);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/queues/${encodedQueueName}/enqueue`, {
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
    const response = await this.fetchWithTimeout(`${this.baseUrl}/queues/${encodedQueueName}/dequeue`, {
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
    return 'payload' in data ? (data.payload as TPayload) : null;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timeoutId =
      controller && this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

    try {
      return await this.fetcher(url, {
        ...init,
        signal: controller?.signal,
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
