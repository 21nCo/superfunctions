import type { RecFnStore } from '../store/types.js';
import type { WebhookPayload } from '../webhooks/events.js';
import {
  deliverWebhook,
  type WebhookDelivererDeps,
} from '../webhooks/deliver.js';
import type { MetricsEmitter } from './watchfn.js';
import { emitWebhookDelivery } from '../observability/metrics.js';

export interface PlugFnWebhookDeps {
  store: RecFnStore;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  metrics?: MetricsEmitter;
}

/**
 * Deliver a webhook event to all configured webhooks for the namespace
 * that subscribe to this event type.
 * Uses plugfn-style delivery: HMAC signing, retry on failure (at-least-once).
 */
export async function deliverWebhookEvent(
  namespace: string,
  eventType: string,
  payload: WebhookPayload,
  deps: PlugFnWebhookDeps,
): Promise<void> {
  const webhooks = await deps.store.listWebhooks(namespace);
  const matching = webhooks.filter((wh) => wh.events.includes(eventType));
  if (matching.length === 0) return;

  const deliverDeps: WebhookDelivererDeps = {
    fetch: deps.fetch,
    maxRetries: deps.maxRetries,
  };

  const results = await Promise.allSettled(
    matching.map((wh) =>
      deliverWebhook(
        { url: wh.url, secret: wh.secret },
        { ...payload, event: eventType as WebhookPayload['event'] },
        deliverDeps,
      ),
    ),
  );

  if (deps.metrics) {
    for (const result of results) {
      const ok = result.status === 'fulfilled' && result.value.ok;
      const attempt = result.status === 'fulfilled' ? result.value.attempt : undefined;
      emitWebhookDelivery(deps.metrics, {
        eventType,
        ok,
        attempt,
        namespace,
      });
    }
  }
  // Don't throw on delivery failure - at-least-once means we attempted; caller continues
}
