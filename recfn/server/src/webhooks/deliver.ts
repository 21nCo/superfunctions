import type { WebhookPayload } from './events.js';
import { computeWebhookSignature } from './sign.js';

const RECFN_SIGNATURE_HEADER = 'X-RecFn-Signature';

const DEFAULT_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface WebhookDelivererDeps {
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
}

export interface WebhookTarget {
  url: string;
  secret?: string;
}

/**
 * Deliver a webhook payload to a target URL.
 * Signs with HMAC-SHA256 when secret is provided.
 * Retries on failure (at-least-once delivery).
 */
export async function deliverWebhook(
  target: WebhookTarget,
  payload: WebhookPayload,
  deps: WebhookDelivererDeps = {},
): Promise<{ ok: boolean; attempt: number }> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const maxRetries = deps.maxRetries ?? DEFAULT_RETRY_ATTEMPTS;

  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (target.secret) {
    headers[RECFN_SIGNATURE_HEADER] = computeWebhookSignature(bodyStr, target.secret);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchFn(target.url, {
        method: 'POST',
        headers,
        body: bodyStr,
      });
      if (res.ok) {
        return { ok: true, attempt };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError ?? new Error('Webhook delivery failed');
}
