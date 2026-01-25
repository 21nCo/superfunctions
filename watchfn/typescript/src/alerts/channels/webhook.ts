"""Webhook notification channel."""

export interface WebhookPayload {
  alert: {
    id: string;
    name: string;
    description?: string;
    severity: string;
    state: string;
    triggeredAt?: number;
  };
  event: "triggered" | "resolved" | "acknowledged";
  timestamp: number;
  value?: number;
  metadata?: Record<string, any>;
}

export interface WebhookOptions {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
}

export class WebhookChannel {
  private options: Required<WebhookOptions>;

  constructor(options: WebhookOptions) {
    this.options = {
      headers: {},
      timeout: 10000,
      retries: 3,
      ...options,
    };
  }

  /**
   * Send notification to webhook
   */
  async send(payload: WebhookPayload): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      try {
        await this.sendRequest(payload);
        return; // Success
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.options.retries - 1) {
          await this.delay(Math.pow(2, attempt) * 1000); // Exponential backoff
        }
      }
    }

    throw lastError;
  }

  private async sendRequest(payload: WebhookPayload): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

