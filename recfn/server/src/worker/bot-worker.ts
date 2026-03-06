import type { PlatformAdapter, Bot } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { QueueAdapter, JobPayload } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import { transitionBot, type LifecycleDeps, type WebhookDeliverer } from './lifecycle.js';
import { sendConsentMessage } from './consent.js';
import { deliverWebhookEvent } from '../integrations/plugfn.js';
import { createAutoLeaveTimer, type AutoLeaveTimer } from './auto-leave.js';
import type { RealtimeTranscriptionPipeline } from '../transcription/realtime.js';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';

export interface BotWorkerConfig {
  store: RecFnStore;
  queue: QueueAdapter;
  logger: Logger;
  platformAdapters: Map<string, PlatformAdapter>;
  realtimePipeline?: RealtimeTranscriptionPipeline;
  streamManager?: TranscriptStreamManager;
  metrics?: import('../integrations/watchfn.js').MetricsEmitter;
}

export interface BotWorker {
  processNext(): Promise<boolean>;
  getAutoLeaveTimer(): AutoLeaveTimer;
}

export function createBotWorker(config: BotWorkerConfig): BotWorker {
  const { store, queue, logger, realtimePipeline, streamManager, metrics } = config;
  const webhookDeliverer: WebhookDeliverer = {
    deliver: (ns, ev, pl) => deliverWebhookEvent(ns, ev, pl, { store, metrics }),
  };
  const lifecycleDeps: LifecycleDeps = {
    store,
    logger,
    streamManager,
    realtimePipeline,
    webhookDeliverer,
    metrics,
  };
  const autoLeaveTimer = createAutoLeaveTimer(lifecycleDeps);

  async function processJoinJob(payload: JobPayload): Promise<void> {
    const botId = payload.data.botId as string;
    const namespace = payload.data.namespace as string;

    const bot = await store.getBot(botId, namespace);
    if (!bot) {
      logger.error('bot.worker.bot_not_found', { botId });
      return;
    }

    if (bot.status !== 'creating') {
      logger.warn('bot.worker.unexpected_status', {
        botId,
        status: bot.status,
      });
      return;
    }

    logger.info('bot.worker.processing', { botId, platform: bot.platform });

    // Transition to joining
    await transitionBot(lifecycleDeps, botId, namespace, 'joining');

    // Get platform adapter
    const adapter = config.platformAdapters.get(bot.platform);
    if (!adapter) {
      await transitionBot(
        lifecycleDeps,
        botId,
        namespace,
        'error',
        `No platform adapter for: ${bot.platform}`,
      );
      return;
    }

    // Attempt to join with timeout
    const joinTimeout = bot.config.joinTimeout ?? 30_000;

    try {
      const joinPromise = adapter.join(bot.meetingUrl, bot.config);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Join timeout exceeded')),
          joinTimeout,
        ),
      );

      await Promise.race([joinPromise, timeoutPromise]);
    } catch (e) {
      const errorMessage =
        e instanceof Error ? e.message : 'Unknown join error';
      await transitionBot(
        lifecycleDeps,
        botId,
        namespace,
        'error',
        errorMessage,
      );
      return;
    }

    // Successfully joined
    await transitionBot(lifecycleDeps, botId, namespace, 'joined');

    // Send consent message before recording (BOT-008, SEC-006)
    const consentMsg =
      bot.config.consentMessage ?? 'This meeting is being recorded';
    await sendConsentMessage(adapter, consentMsg, botId, logger);

    // Transition to recording (only after consent message sent)
    await transitionBot(lifecycleDeps, botId, namespace, 'recording');

    // Set up participant monitoring for auto-leave
    setupParticipantMonitoring(bot, adapter);

    // Broadcast participant events to websocket and fire webhooks
    const { buildParticipantJoinedPayload, buildParticipantLeftPayload } = await import('../webhooks/events.js');
    adapter.onParticipantJoin(async (participant) => {
      if (config.streamManager) {
        config.streamManager.broadcast(botId, 'participant_joined', participant);
      }
      // Ensure consent default: pending when bot joins, unknown if platform omits
      const p = {
        ...participant,
        consent: participant.consent ?? 'pending',
      };
      await store.addParticipant(botId, p, bot.namespace);
      webhookDeliverer.deliver(bot.namespace, 'participant.joined', buildParticipantJoinedPayload(botId, p)).catch(() => {});
    });
    adapter.onParticipantLeave(async (participantId) => {
      await store.updateParticipant(botId, participantId, bot.namespace, {
        leftAt: new Date().toISOString(),
      });
      if (config.streamManager) {
        config.streamManager.broadcast(botId, 'participant_left', { participantId });
      }
      webhookDeliverer.deliver(bot.namespace, 'participant.left', buildParticipantLeftPayload(botId, participantId)).catch(() => {});
    });

    if (bot.config.enableRealTimeTranscript && config.realtimePipeline) {
      const audioStream = adapter.getAudioStream();
      if (audioStream) {
        config.realtimePipeline.start(botId, audioStream).catch(e => {
          logger.error('bot.worker.realtime_error', { botId, error: String(e) });
        });
      } else {
        logger.warn('bot.worker.no_audio_stream', { botId });
      }
    }
  }

  function setupParticipantMonitoring(
    bot: Bot,
    adapter: PlatformAdapter,
  ): void {
    adapter.onParticipantJoin(() => {
      autoLeaveTimer.onParticipantJoin(bot.id);
    });

    adapter.onParticipantLeave(async () => {
      const participants = await adapter.getParticipants();
      const nonBotCount = participants.filter(
        (p) => p.role !== 'bot',
      ).length;
      // Refetch bot to get latest state
      const currentBot = await store.getBot(bot.id, bot.namespace);
      if (currentBot && currentBot.status === 'recording') {
        autoLeaveTimer.onParticipantLeave(currentBot, nonBotCount);
      }
    });
  }

  return {
    async processNext(): Promise<boolean> {
      const job = await queue.dequeue(QUEUE_NAMES.BOT_JOIN);
      if (!job) return false;

      try {
        await processJoinJob(job);
      } catch (e) {
        logger.error('bot.worker.error', {
          error: e instanceof Error ? e.message : String(e),
          jobType: job.type,
        });
      }

      return true;
    },

    getAutoLeaveTimer(): AutoLeaveTimer {
      return autoLeaveTimer;
    },
  };
}
