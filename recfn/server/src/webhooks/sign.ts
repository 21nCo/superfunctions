import { signWebhookPayload } from '@superfunctions/webhooks';

/**
 * Compute HMAC-SHA256 signature for webhook payload.
 * Used in X-RecFn-Signature header.
 */
export function computeWebhookSignature(body: string, secret: string): string {
  return signWebhookPayload(body, secret, { algorithm: 'sha256', encoding: 'hex' });
}
