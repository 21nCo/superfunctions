import { createHmac } from 'node:crypto';

/**
 * Compute HMAC-SHA256 signature for webhook payload.
 * Used in X-RecFn-Signature header.
 */
export function computeWebhookSignature(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  return hmac.digest('hex');
}
