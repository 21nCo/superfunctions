import { ErrorCode, RecFnError, type Bot, type PlatformAdapter } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type {
  BotJoinJobData,
  JobPayload,
  QueueAdapter,
  RecordingUploadJobData,
} from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import { transitionBot, type LifecycleDeps, type WebhookDeliverer } from './lifecycle.js';
import { sendConsentMessage } from './consent.js';
import { deliverWebhookEvent } from '../integrations/plugfn.js';
import { createAutoLeaveTimer, type AutoLeaveTimer } from './auto-leave.js';
import type { RealtimeTranscriptionPipeline } from '../transcription/realtime.js';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';
import type { StorageAdapter } from '../integrations/storage.js';
import {
  assertCaptureHasData,
  captureFromStream,
  type CaptureResult,
} from '../recording/capture.js';
import { uploadRecording } from '../recording/storage.js';

export type PlatformAdapterFactory = () => PlatformAdapter;

export interface BotWorkerConfig {
  store: RecFnStore;
  queue: QueueAdapter;
  logger: Logger;
  platformAdapters?: Map<string, PlatformAdapter>;
  platformAdapterFactories?: Map<string, PlatformAdapterFactory>;
  storage?: StorageAdapter;
  realtimePipeline?: RealtimeTranscriptionPipeline;
  streamManager?: TranscriptStreamManager;
  metrics?: import('../integrations/watchfn.js').MetricsEmitter;
}

export interface BotWorker {
  processNext(): Promise<boolean>;
  getAutoLeaveTimer(): AutoLeaveTimer;
}

interface ActiveBotSession {
  botId: string;
  namespace: string;
  adapter: PlatformAdapter;
  capturePromise: Promise<CaptureResult>;
}

export function createBotWorker(config: BotWorkerConfig): BotWorker {
  const {
    store,
    queue,
    logger,
    realtimePipeline,
    streamManager,
    metrics,
    storage,
  } = config;
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
    queue,
  };
  const autoLeaveTimer = createAutoLeaveTimer(lifecycleDeps);
  const activeSessions = new Map<string, ActiveBotSession>();

  function resolvePlatformAdapter(platform: string): PlatformAdapter | undefined {
    const factory = config.platformAdapterFactories?.get(platform);
    if (factory) {
      return factory();
    }

    return config.platformAdapters?.get(platform);
  }

  async function persistMetadataSnapshot(
    bot: Bot,
    adapter: PlatformAdapter,
      stage: 'joined' | 'recording' | 'leaving' | 'done',
  ): Promise<void> {
    try {
      const [existingMetadata, persistedChatMessages, adapterMetadata] =
        await Promise.all([
          store.getMetadata(bot.id, bot.namespace),
          store.getChatMessages(bot.id, bot.namespace),
          adapter.getMetadata(),
        ]);

      const now = new Date().toISOString();
      const metadataStartTime =
        adapterMetadata.startTime ??
        existingMetadata?.startTime ??
        (stage === 'joined' || stage === 'recording' ? now : undefined);
      const metadataEndTime =
        adapterMetadata.endTime ??
        existingMetadata?.endTime ??
        (stage === 'leaving' || stage === 'done' ? now : undefined);

      await store.upsertMetadata(
        bot.id,
        {
          id:
            adapterMetadata.id ||
            existingMetadata?.id ||
            `meta_${bot.id}`,
          botId: bot.id,
          title: adapterMetadata.title ?? existingMetadata?.title,
          startTime: metadataStartTime,
          endTime: metadataEndTime,
          platform: adapterMetadata.platform ?? bot.platform,
          chatMessages:
            persistedChatMessages.length > 0
              ? persistedChatMessages
              : (adapterMetadata.chatMessages ?? existingMetadata?.chatMessages ?? []),
        },
        bot.namespace,
      );
    } catch (error) {
      logger.warn('bot.worker.metadata_snapshot_failed', {
        botId: bot.id,
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function startCaptureSession(bot: Bot, adapter: PlatformAdapter): Promise<CaptureResult> {
    let recordingStream = adapter.getAudioStream();
    if (bot.config.enableRealTimeTranscript && config.realtimePipeline) {
      const [realtimeStream, finalizedRecordingStream] = recordingStream.tee();
      recordingStream = finalizedRecordingStream;
      void config.realtimePipeline.start(bot.id, realtimeStream, {
        language: bot.config.language ?? 'en-US',
        platform: bot.platform,
        asrProvider: bot.config.asrProvider ?? 'whisper',
      });
    }

    return captureFromStream(recordingStream, {
      recordingFormat: bot.config.recordingFormat ?? 'mp4',
    });
  }

  async function processFinalizeRecordingJob(payload: JobPayload): Promise<void> {
    const { botId, namespace } = payload.data as unknown as RecordingUploadJobData;
    const bot = await store.getBot(botId, namespace);
    if (!bot) {
      logger.error('recording.finalization.bot_not_found', { botId, namespace });
      return;
    }

    const session = activeSessions.get(botId);
    if (!session) {
      logger.error('recording.finalization.failed', {
        botId,
        namespace,
        code: ErrorCode.RECORDING_FINALIZATION_FAILED,
        error: 'No active capture session found.',
      });
      await transitionBot(
        lifecycleDeps,
        botId,
        namespace,
        'error',
        `${ErrorCode.RECORDING_FINALIZATION_FAILED}: no active capture session found.`,
      );
      return;
    }

    if (!storage) {
      logger.error('recording.finalization.failed', {
        botId,
        namespace,
        code: ErrorCode.RECORDING_FINALIZATION_FAILED,
        error: 'No storage adapter configured for recording finalization.',
      });
      activeSessions.delete(botId);
      await transitionBot(
        lifecycleDeps,
        botId,
        namespace,
        'error',
        `${ErrorCode.RECORDING_FINALIZATION_FAILED}: storage is not configured.`,
      );
      return;
    }

    logger.info('recording.finalization.start', { botId, namespace });

    try {
      await transitionBot(lifecycleDeps, botId, namespace, 'finalizing');
      await persistMetadataSnapshot(bot, session.adapter, 'leaving');
      await session.adapter.leave();

      const capture = await session.capturePromise;
      assertCaptureHasData(capture);
      const { recording } = await uploadRecording(
        {
          botId,
          namespace,
          capture,
          source: 'bot_finalization',
        },
        {
          storage,
          store,
          logger,
          webhookDeliverer,
          metrics,
        },
      );

      await persistMetadataSnapshot(bot, session.adapter, 'done');
      await transitionBot(lifecycleDeps, botId, namespace, 'done');
      logger.info('recording.finalization.complete', {
        botId,
        namespace,
        recordingId: recording.id,
      });
    } catch (error) {
      const errorCode =
        error instanceof RecFnError
          ? error.code
          : ErrorCode.RECORDING_FINALIZATION_FAILED;
      logger.error('recording.finalization.failed', {
        botId,
        namespace,
        code: errorCode,
        error: error instanceof Error ? error.message : String(error),
      });
      await transitionBot(
        lifecycleDeps,
        botId,
        namespace,
        'error',
        `${errorCode}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      activeSessions.delete(botId);
    }
  }

  async function processJoinJob(payload: JobPayload): Promise<void> {
    const { botId, namespace } = payload.data as unknown as BotJoinJobData;

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

    // Create or resolve a platform adapter for this specific bot session.
    const adapter = resolvePlatformAdapter(bot.platform);
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
      const joinConfig = {
        ...bot.config,
        __botId: bot.id,
      } as typeof bot.config & { __botId: string };
      const joinPromise = adapter.join(bot.meetingUrl, joinConfig);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Join timeout exceeded')),
          joinTimeout + 5_000,
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
    await persistMetadataSnapshot(bot, adapter, 'joined');

    if (process.env.RECFN_POC_JOIN_ONLY === '1') {
      logger.info('bot.join_only.active', { botId, namespace });
      activeSessions.set(botId, {
        botId,
        namespace,
        adapter,
        capturePromise: Promise.resolve({
          data: new Uint8Array(),
          format: 'wav',
          duration: 0,
          size: 0,
        }),
      });
      setupParticipantMonitoring(bot, adapter);
      return;
    }

    // Send consent message before recording (BOT-008, SEC-006)
    const consentMsg =
      bot.config.consentMessage ?? 'This meeting is being recorded';
    await sendConsentMessage(adapter, consentMsg, botId, logger);

    // Transition to recording (only after consent message sent)
    await transitionBot(lifecycleDeps, botId, namespace, 'recording');
    await persistMetadataSnapshot(bot, adapter, 'recording');
    const capturePromise = startCaptureSession(bot, adapter);
    void capturePromise.catch(async (error) => {
      const errorMessage =
        error instanceof Error ? error.message : 'Could not start audio capture.';
      logger.error('recording.capture.failed', {
        botId,
        namespace,
        error: errorMessage,
      });
      await transitionBot(lifecycleDeps, botId, namespace, 'error', errorMessage);
      await adapter.leave().catch(() => {});
      activeSessions.delete(botId);
    });
    activeSessions.set(botId, {
      botId,
      namespace,
      adapter,
      capturePromise,
    });

    // Set up participant monitoring for auto-leave
    setupParticipantMonitoring(bot, adapter);

    // Broadcast participant events to websocket and fire webhooks
    const { buildParticipantJoinedPayload, buildParticipantLeftPayload } = await import('../webhooks/events.js');
    adapter.onParticipantJoin(async (participant) => {
      // Normalize participant payload before persistence and websocket emission.
      const p = {
        ...participant,
        botId,
        consent: participant.consent ?? 'pending',
      };
      if (config.streamManager) {
        config.streamManager.broadcast(botId, 'participant_joined', p);
      }
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
    adapter.onChatMessage(async (message) => {
      const persistedMessage = {
        participantId: message.participantId,
        text: message.text,
        timestamp: message.timestamp || new Date().toISOString(),
      };
      await store.addChatMessage(botId, persistedMessage, bot.namespace);
      await persistMetadataSnapshot(bot, adapter, 'recording');
    });
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
      const job =
        (await queue.dequeue(QUEUE_NAMES.BOT_JOIN)) ??
        (await queue.dequeue(QUEUE_NAMES.RECORDING_UPLOAD));
      if (!job) return false;

      try {
        if (job.type === 'recording.finalize') {
          await processFinalizeRecordingJob(job);
        } else {
          await processJoinJob(job);
        }
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
