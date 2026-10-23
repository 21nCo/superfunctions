import type { Bot, BotStatus } from '@recfn/core';
import { assertTransition } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { Logger } from '../integrations/logfn.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';
import type { RealtimeTranscriptionPipeline } from '../transcription/realtime.js';
import type { WebhookPayload } from '../webhooks/events.js';
import type { MetricsEmitter } from '../integrations/watchfn.js';
import { recordJoinLatency } from '../observability/latency.js';
import { emitBotsActive } from '../observability/metrics.js';

export interface WebhookDeliverer {
  deliver(
    namespace: string,
    eventType: string,
    payload: WebhookPayload,
  ): Promise<void>;
}

export interface LifecycleDeps {
  store: RecFnStore;
  logger: Logger;
  streamManager?: TranscriptStreamManager;
  realtimePipeline?: RealtimeTranscriptionPipeline;
  webhookDeliverer?: WebhookDeliverer;
  metrics?: MetricsEmitter;
  queue?: QueueAdapter;
}

export async function transitionBot(
  deps: LifecycleDeps,
  botId: string,
  namespace: string,
  newStatus: BotStatus,
  errorMessage?: string,
): Promise<Bot | null> {
  const { store } = deps;

  const bot = await store.getBot(botId, namespace);
  if (!bot) return null;

  assertTransition(bot.status, newStatus);

  const updates: Partial<Pick<Bot, 'status' | 'errorMessage' | 'updatedAt'>> =
    {
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };

  if (errorMessage !== undefined) {
    updates.errorMessage = errorMessage;
  }

  const updated = await store.updateBot(botId, namespace, updates);

  return notifyBotTransition(deps, bot, updated, newStatus, errorMessage);
}

/** Emit effects after a transition already committed by an atomic store claim. */
export async function notifyBotTransition(deps: LifecycleDeps, bot: Bot, updated: Bot | null, newStatus: BotStatus, errorMessage?: string): Promise<Bot | null> {
  const { store, logger, streamManager, realtimePipeline, webhookDeliverer, metrics, queue } = deps;
  const botId = bot.id; const namespace = bot.namespace;
  logger.info('bot.status_change', {
    botId,
    from: bot.status,
    to: newStatus,
    ...(errorMessage ? { errorMessage } : {}),
  });

  if (streamManager) {
    streamManager.broadcast(botId, 'status', { botStatus: newStatus });
  }

  if (newStatus === 'leaving' && queue) {
    await queue.enqueue(QUEUE_NAMES.RECORDING_UPLOAD, {
      type: 'recording.finalize',
      data: { botId, namespace },
      createdAt: new Date().toISOString(),
    });
    logger.info('recording.finalization.queued', { botId, namespace });
  }

  if (
    newStatus === 'leaving' ||
    newStatus === 'finalizing' ||
    newStatus === 'left' ||
    newStatus === 'error'
  ) {
    if (realtimePipeline) realtimePipeline.stop(botId);
    if (streamManager) streamManager.closeAll(botId, 1000, `Bot transitioned to ${newStatus}`);
  }

  if (newStatus === 'joined' && bot.status === 'joining') {
    const createdAt = new Date(bot.createdAt).getTime();
    const joinedAt = Date.now();
    const latencyMs = joinedAt - createdAt;
    recordJoinLatency({ botId, latencyMs, namespace, logger, metrics });
  }

  if (metrics && (newStatus === 'joined' || newStatus === 'left' || newStatus === 'error')) {
    const active = await store.listBots(namespace, { limit: 1000 });
    const count = active.items.filter(
      (b) => ['creating', 'joining', 'joined', 'recording', 'leaving'].includes(b.status),
    ).length;
    emitBotsActive(metrics, count, namespace);
  }

  if (webhookDeliverer) {
    const { buildBotJoiningPayload, buildBotJoinedPayload, buildBotLeftPayload, buildBotErrorPayload } = await import('../webhooks/events.js');
    if (newStatus === 'joining') {
      webhookDeliverer.deliver(namespace, 'bot.joining', buildBotJoiningPayload(updated!)).catch(() => {});
    } else if (newStatus === 'joined') {
      webhookDeliverer.deliver(namespace, 'bot.joined', buildBotJoinedPayload(updated!)).catch(() => {});
    } else if (newStatus === 'left') {
      webhookDeliverer.deliver(namespace, 'bot.left', buildBotLeftPayload(updated!)).catch(() => {});
    } else if (newStatus === 'error') {
      webhookDeliverer.deliver(namespace, 'bot.error', buildBotErrorPayload(botId, bot.meetingUrl, bot.platform, errorMessage ?? '')).catch(() => {});
    }
  }

  return updated;
}
