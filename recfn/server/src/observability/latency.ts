/**
 * Bot join latency tracker.
 * Target: <10s. Log warning if exceeded; emit metric when MetricsEmitter available.
 */

const JOIN_LATENCY_TARGET_MS = 10_000;

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

import type { MetricsEmitter } from '../integrations/watchfn.js';
import { emitJoinLatency } from './metrics.js';

export interface RecordJoinLatencyOpts {
  botId: string;
  latencyMs: number;
  namespace?: string;
  logger: Logger;
  metrics?: MetricsEmitter;
}

/**
 * Record bot join latency. Logs the latency; warns if exceeds 10s target.
 * Emits recfn.bot.join_latency_ms when metrics provided.
 */
export function recordJoinLatency(opts: RecordJoinLatencyOpts): void {
  const { botId, latencyMs, namespace, logger, metrics } = opts;

  logger.info('bot.join_latency', { botId, latencyMs, ...(namespace ? { namespace } : {}) });

  if (latencyMs > JOIN_LATENCY_TARGET_MS) {
    logger.warn('bot.join_latency.exceeded_target', {
      botId,
      latencyMs,
      targetMs: JOIN_LATENCY_TARGET_MS,
      ...(namespace ? { namespace } : {}),
    });
  }

  if (metrics) {
    emitJoinLatency(metrics, latencyMs, { botId, namespace });
  }
}
