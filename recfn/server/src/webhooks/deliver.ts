import { deliverWebhook as deliverWithSharedPackage } from '@superfunctions/webhooks';
import type { WebhookPayload } from './events.js';

const RECFN_SIGNATURE_HEADER = 'X-RecFn-Signature';

const DEFAULT_RETRY_ATTEMPTS = 3;

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
  const maxRetries = deps.maxRetries ?? DEFAULT_RETRY_ATTEMPTS;
  const result = await deliverWithSharedPackage(
    {
      url: target.url,
      payload,
      secret: target.secret,
      signatureHeader: RECFN_SIGNATURE_HEADER,
    },
    {
      fetch: deps.fetch,
      maxRetries,
      initialDelayMs: 1000,
    }
  );

  if (!result.ok) {
    const lastAttempt = result.attempts[result.attempts.length - 1];
    throw new Error(lastAttempt?.error ?? 'Webhook delivery failed');
  }

  return {
    ok: true,
    attempt: result.attempts.length,
  };
}
