/**
 * RecFn metric names and emission helpers.
 * Emit to watchfn or equivalent when MetricsEmitter is configured.
 */

export const METRICS = {
  BOTS_ACTIVE: 'recfn.bots.active',
  RECORDINGS_COUNT: 'recfn.recordings.count',
  RECORDING_UPLOAD_LATENCY_MS: 'recfn.recording.upload_latency_ms',
  ASR_LATENCY_MS: 'recfn.asr.latency_ms',
  JOIN_LATENCY_MS: 'recfn.bot.join_latency_ms',
  WEBHOOK_DELIVERY: 'recfn.webhook.delivery',
  WEBHOOK_DELIVERY_FAILED: 'recfn.webhook.delivery_failed',
  CALENDAR_SCHEDULE_DECISION: 'recfn.calendar.schedule_decision',
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

export function emitRecordingUploadLatency(
  metrics: MetricsEmitter,
  latencyMs: number,
  opts: { botId?: string; recordingId?: string; namespace?: string } = {},
): void {
  metrics.track(METRICS.RECORDING_UPLOAD_LATENCY_MS, {
    latencyMs,
    ...opts,
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

export function emitCalendarScheduleDecision(
  metrics: MetricsEmitter,
  opts: {
    decision: 'poll' | 'created' | 'skip_existing' | 'skip_outside_window' | 'skip_invalid_url' | 'failed';
    namespace: string;
    calendarId: string;
    provider: string;
    eventId?: string;
    botId?: string;
    platform?: string;
  },
): void {
  metrics.track(METRICS.CALENDAR_SCHEDULE_DECISION, opts);
}

export function emitApiRequest(
  metrics: MetricsEmitter,
  opts: { method: string; path: string; status?: number; durationMs?: number },
): void {
  metrics.track(METRICS.API_REQUEST, opts);
}
