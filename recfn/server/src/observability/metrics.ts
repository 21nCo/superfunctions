/**
 * RecFn metric names and emission helpers.
 * Emit to watchfn or equivalent when MetricsEmitter is configured.
 */

export const METRICS = {
  BOTS_ACTIVE: 'recfn.bots.active',
  RECORDINGS_COUNT: 'recfn.recordings.count',
  ASR_LATENCY_MS: 'recfn.asr.latency_ms',
  JOIN_LATENCY_MS: 'recfn.bot.join_latency_ms',
  WEBHOOK_DELIVERY: 'recfn.webhook.delivery',
  WEBHOOK_DELIVERY_FAILED: 'recfn.webhook.delivery_failed',
  API_REQUEST: 'recfn.api.request',
} as const;

import type { MetricsEmitter } from '../integrations/watchfn.js';

export { type MetricsEmitter } from '../integrations/watchfn.js';

export function emitBotsActive(
  metrics: MetricsEmitter,
  count: number,
  namespace?: string,
): void {
  metrics.track(METRICS.BOTS_ACTIVE, {
    count,
    ...(namespace ? { namespace } : {}),
  });
}

export function emitRecordingsCount(
  metrics: MetricsEmitter,
  count: number,
  namespace?: string,
): void {
  metrics.track(METRICS.RECORDINGS_COUNT, {
    count,
    ...(namespace ? { namespace } : {}),
  });
}

export function emitAsrLatency(
  metrics: MetricsEmitter,
  latencyMs: number,
  opts: { recordingId?: string; asrProvider?: string; namespace?: string } = {},
): void {
  metrics.track(METRICS.ASR_LATENCY_MS, {
    latencyMs,
    ...opts,
  });
}

export function emitJoinLatency(
  metrics: MetricsEmitter,
  latencyMs: number,
  opts: { botId?: string; namespace?: string } = {},
): void {
  metrics.track(METRICS.JOIN_LATENCY_MS, {
    latencyMs,
    ...opts,
  });
}

export function emitWebhookDelivery(
  metrics: MetricsEmitter,
  opts: { eventType: string; ok: boolean; attempt?: number; namespace?: string },
): void {
  const event = opts.ok ? METRICS.WEBHOOK_DELIVERY : METRICS.WEBHOOK_DELIVERY_FAILED;
  metrics.track(event, opts);
}

export function emitApiRequest(
  metrics: MetricsEmitter,
  opts: { method: string; path: string; status?: number; durationMs?: number },
): void {
  metrics.track(METRICS.API_REQUEST, opts);
}
