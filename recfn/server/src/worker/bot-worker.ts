import { randomUUID } from 'node:crypto';
import { ErrorCode, RecFnError, type Bot, type PlatformAdapter } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import { assertProductionStore } from '../store/db.js';
import type {
  BotJoinJobData,
  JobPayload,
  QueueAdapter,
  RecordingUploadJobData,
} from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import { transitionBot, notifyBotTransition, type LifecycleDeps, type WebhookDeliverer } from './lifecycle.js';
import { sendConsentMessage } from './consent.js';
import { deliverWebhookEvent } from '../integrations/plugfn.js';
import { createAutoLeaveTimer, type AutoLeaveTimer } from './auto-leave.js';
import type { RealtimeTranscriptionPipeline } from '../transcription/realtime.js';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';
import type { StorageAdapter } from '../integrations/storage.js';
import {
  assertCaptureHasData,
  captureToFile,
  type CaptureResult,
  type CaptureArtifact,
  type CaptureOptions,
} from '../recording/capture.js';
import { splitAudio } from '../recording/bounded-audio-split.js';
import { uploadRecording } from '../recording/storage.js';

export type PlatformAdapterFactory = () => PlatformAdapter;

export interface BotWorkerConfig {
  /** Production workers require managed scratch with verifiable host ownership. */
  environment?: 'production' | 'development' | 'test';
  /** Explicit bounded namespace set drained for durable join recovery; required in production. */
  recoveryNamespaces?: readonly string[];
  /** Deadline for acknowledging local shutdown; unresolved external operations retain ownership. */
  shutdownTimeoutMs?: number;
  store: RecFnStore;
  queue: QueueAdapter;
  logger: Logger;
  platformAdapters?: Map<string, PlatformAdapter>;
  platformAdapterFactories?: Map<string, PlatformAdapterFactory>;
  storage?: StorageAdapter;
  /** Host encoder paths and bounded media capture resources. */
  captureOptions?: Omit<CaptureOptions, 'recordingFormat' | 'videoStream'>;
  /** Finite total storage-upload deadline; defaults to five minutes. */
  uploadTimeoutMs?: number;
  realtimePipeline?: RealtimeTranscriptionPipeline;
  streamManager?: TranscriptStreamManager;
  metrics?: import('../integrations/watchfn.js').MetricsEmitter;
}

export interface BotWorker {
  processNext(): Promise<boolean>;
  /** Stop dequeuing first, then cancel active media and release retained artifacts. */
  cancelCaptures(): Promise<{ unresolvedBotIds: string[] }>;
  getAutoLeaveTimer(): AutoLeaveTimer;
}

interface OwnedJoin {
  bot: Bot; token: string; abort: AbortController; adapter?: PlatformAdapter; joinSettled: boolean; joinPromise?: Promise<void>;
  cancelled: boolean; providerStopped: boolean; joinAttempted: boolean; joinSucceeded: boolean; cleanup?: Promise<boolean>; stopping?: Promise<void>;
}

interface ActiveBotSession {
  botId: string;
  namespace: string;
  adapter: PlatformAdapter;
  capturePromise: Promise<CaptureResult | CaptureArtifact>;
  recordingRequired: boolean;
  captureAbort?: AbortController;
}

export function createBotWorker(config: BotWorkerConfig): BotWorker {
  const assertScratch = () => {
    if ((config.environment ?? process.env.NODE_ENV) === 'production' &&
      (!config.captureOptions?.scratch?.supportsCleanup || config.captureOptions.temporaryDirectory)) {
      throw new Error('Production recording workers require managed, cleanup-capable recording scratch.');
    }
  };
  assertScratch();
  const recoveryNamespaces = [...new Set(config.recoveryNamespaces ?? [])];
  if (recoveryNamespaces.length > 100 || recoveryNamespaces.some(value => !value.trim())) throw new TypeError('Configure 1..100 nonempty recovery namespaces.');
  if ((config.environment ?? process.env.NODE_ENV) === 'production' && !recoveryNamespaces.length) throw new Error('Production workers require explicit durable join recovery namespaces.');
  if ((config.environment ?? process.env.NODE_ENV) === 'production') assertProductionStore(config.store);
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) throw new TypeError('shutdownTimeoutMs must be positive.');
  const owners = new Map<string, OwnedJoin>();
  let closing = false;
  let processing = false;
  let recoveryTurn = true;
  let recoveryIndex = 0;
  const recoveryCursors = new Map<string, string>();
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
    store: { ...store, updateBot: (id, namespace, updates) => store.updateBot(id, namespace, updates, owners.get(id)?.token) },
    logger,
    streamManager,
    realtimePipeline,
    webhookDeliverer,
    metrics,
    queue,
  };
  const autoLeaveTimer = createAutoLeaveTimer(lifecycleDeps);
  const activeSessions = new Map<string, ActiveBotSession>();

  async function publishTransition(before: Bot, after: Bot): Promise<void> {
    if (before.status === after.status) return;
    try { await notifyBotTransition(lifecycleDeps, before, after, after.status, after.errorMessage); }
    catch (error) { logger.error('bot.worker.transition_notification_failed', { botId: after.id, error: String(error) }); }
  }

  async function stopProvider(owner: OwnedJoin): Promise<void> {
    if (!owner.joinSettled) throw new Error('Join remains pending; provider stop cannot yet be established.');
    if (!owner.stopping) owner.stopping = (async () => {
      if (owner.adapter && !owner.providerStopped) await owner.adapter.leave();
      owner.providerStopped = true;
    })();
    return owner.stopping;
  }

  function cleanupOwner(owner: OwnedJoin, reason: string): Promise<boolean> {
    owner.cancelled = true;
    if (!owner.joinSettled) return Promise.resolve(false);
    if (owner.cleanup) return owner.cleanup;
    owner.cleanup = (async () => {
      const session = activeSessions.get(owner.bot.id);
      session?.captureAbort?.abort(); realtimePipeline?.stop(owner.bot.id);
      try {
        await stopProvider(owner);
        if (owner.joinAttempted && !owner.joinSucceeded) throw new Error('Join outcome unknown; leave acknowledgement cannot prove remote session termination.');
        if (session) {
          const capture = await session.capturePromise.catch(() => undefined);
          if (capture && 'dispose' in capture) await capture.dispose();
        }
        const completed = await store.completeBotWork(owner.bot.id, owner.bot.namespace, owner.token, 'error', reason);
        await publishTransition(completed.before, completed.after);
        activeSessions.delete(owner.bot.id); owners.delete(owner.bot.id);
        return true;
      } catch (error) {
        await store.markBotWorkUncertain(owner.bot.id, owner.bot.namespace, owner.token, String(error).slice(0, 1000)).catch(() => {});
        logger.error('bot.worker.cleanup_uncertain', { botId: owner.bot.id, error: String(error) });
        return false;
      }
    })();
    return owner.cleanup;
  }

  async function failOwner(owner: OwnedJoin, reason: string): Promise<void> {
    owner.cancelled = true; owner.abort.abort();
    const current = await store.getBotWork(owner.bot.id, owner.bot.namespace);
    if (current?.state === 'closed') return;
    const changed = await store.markBotWorkUncertain(owner.bot.id, owner.bot.namespace, owner.token, reason.slice(0, 1000)).catch(async error => {
      if ((await store.getBotWork(owner.bot.id, owner.bot.namespace))?.state !== 'closed') throw error;
      return null;
    });
    if (changed) await publishTransition(changed.before, changed.after);
    const cleanup = cleanupOwner(owner, reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([cleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, shutdownTimeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

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

  async function startCaptureSession(bot: Bot, adapter: PlatformAdapter, signal: AbortSignal): Promise<CaptureResult | CaptureArtifact> {
    assertScratch();
    const videoStream = (bot.config.recordingFormat ?? 'mp4') === 'mp4' ? adapter.getVideoStream?.() : undefined;
    let recordingStream;
    try { recordingStream = adapter.getAudioStream(); }
    catch (error) { void videoStream?.cancel().catch(() => {}); throw error; }
    if (bot.config.enableRealTimeTranscript && config.realtimePipeline) {
      const [realtimeStream, finalizedRecordingStream] = splitAudio(recordingStream, signal);
      recordingStream = finalizedRecordingStream;
      void config.realtimePipeline.start(bot.id, realtimeStream, {
        language: bot.config.language ?? 'en-US',
        platform: bot.platform,
        asrProvider: bot.config.asrProvider ?? 'whisper',
      });
    }

    return captureToFile(recordingStream, {
      ...config.captureOptions,
      signal: config.captureOptions?.signal ? AbortSignal.any([signal, config.captureOptions.signal]) : signal,
      recordingFormat: bot.config.recordingFormat ?? 'mp4',
      videoStream,
    });
  }

  function setupChatMessagePersistence(
    bot: Bot,
    adapter: PlatformAdapter,
    metadataStage: 'joined' | 'recording' = 'recording',
  ): void {
    adapter.onChatMessage(async (message) => {
      const persistedMessage = {
        participantId: message.participantId,
        text: message.text,
        timestamp: message.timestamp || new Date().toISOString(),
      };
      await store.addChatMessage(bot.id, persistedMessage, bot.namespace);
      await persistMetadataSnapshot(bot, adapter, metadataStage);
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
      logger.warn('recording.finalization.not_local_owner', { botId, namespace });
      return;
    }
    const owner = owners.get(botId);
    if (!owner || owner.cancelled) return;

    if (!session.recordingRequired) {
      logger.info('bot.join_only.finalization.start', { botId, namespace });
      try {
        await persistMetadataSnapshot(bot, session.adapter, 'leaving');
        await stopProvider(owner);
        await persistMetadataSnapshot(bot, session.adapter, 'done');
        const completed = await store.completeBotWork(botId, namespace, owner.token, 'done', 'Provider leave acknowledged; join-only session stopped.');
        const left = { ...completed.after, status: 'left' as const };
        await publishTransition(completed.before, left);
        await publishTransition(left, completed.after);
        owners.delete(botId);
        logger.info('bot.join_only.finalization.complete', { botId, namespace });
      } catch (error) {
        logger.error('bot.join_only.finalization.failed', {
          botId,
          namespace,
          error: error instanceof Error ? error.message : String(error),
        });
        await failOwner(owner, error instanceof Error ? error.message : String(error));
      } finally {
        activeSessions.delete(botId);
      }
      return;
    }

    if (!storage) {
      session.captureAbort?.abort();
      await session.capturePromise.then(capture => 'dispose' in capture ? capture.dispose() : undefined).catch(() => {});
      logger.error('recording.finalization.failed', {
        botId,
        namespace,
        code: ErrorCode.RECORDING_FINALIZATION_FAILED,
        error: 'No storage adapter configured for recording finalization.',
      });
      activeSessions.delete(botId);
      await failOwner(owner, 'Recording finalization storage is not configured.');
      return;
    }

    logger.info('recording.finalization.start', { botId, namespace });

    try {
      await transitionBot(lifecycleDeps, botId, namespace, 'finalizing');
      await persistMetadataSnapshot(bot, session.adapter, 'leaving');
      await stopProvider(owner);

      const capture = await session.capturePromise;
      assertCaptureHasData(capture);
      const { recording } = await uploadRecording(
        {
          botId,
          namespace,
          capture,
          source: 'bot_finalization',
          uploadTimeoutMs: config.uploadTimeoutMs,
          signal: session.captureAbort?.signal,
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
      const completed = await store.completeBotWork(botId, namespace, owner.token, 'done', 'Provider leave acknowledged; capture and upload completed.');
      await publishTransition(completed.before, completed.after);
      owners.delete(botId);
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
      await failOwner(owner, `${errorCode}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      session.captureAbort?.abort();
      await session.capturePromise.then(capture => 'dispose' in capture ? capture.dispose() : undefined).catch(() => {});
      activeSessions.delete(botId);
    }
  }

  async function processJoinJob(payload: JobPayload): Promise<void> {
    const { botId, namespace } = payload.data as unknown as BotJoinJobData;

    if (closing) return;
    const token = randomUUID();
    const bot = await store.claimBotJoin(botId, namespace, token);
    if (!bot) return;
    const owner: OwnedJoin = { bot, token, abort: new AbortController(), joinSettled: false, cancelled: closing, providerStopped: false, joinAttempted: false, joinSucceeded: false };
    owners.set(botId, owner);
    if (closing) { owner.joinSettled = true; await failOwner(owner, 'Worker stopped before provider acquisition.'); return; }
    try { await notifyBotTransition(lifecycleDeps, { ...bot, status: 'creating' }, bot, 'joining'); }
    catch (error) { owner.joinSettled = true; await failOwner(owner, String(error)); return; }
    if (closing || owner.cancelled) { owner.joinSettled = true; await failOwner(owner, 'Worker stopped before provider factory.'); return; }
    logger.info('bot.worker.processing', { botId, platform: bot.platform });

    // Create or resolve a platform adapter for this specific bot session.
    let adapter: PlatformAdapter | undefined;
    try { adapter = resolvePlatformAdapter(bot.platform); }
    catch (error) { owner.joinSettled = true; owner.joinAttempted = true; await failOwner(owner, String(error)); return; }
    if (!adapter) { owner.joinSettled = true; await failOwner(owner, `No platform adapter for: ${bot.platform}`); return; }
    owner.adapter = adapter;

    // Attempt to join with timeout
    const joinTimeout = bot.config.joinTimeout ?? 30_000;

    try {
      const joinConfig = {
        ...bot.config,
        __botId: bot.id,
      } as typeof bot.config & { __botId: string };
      const joinPromise = Promise.resolve().then(() => {
        if (owner.cancelled || closing) throw new Error('Worker stopped before provider join.');
        owner.joinAttempted = true;
        return adapter!.join(bot.meetingUrl, joinConfig);
      });
      owner.joinPromise = joinPromise;
      void joinPromise.then(() => { owner.joinSettled = true; owner.joinSucceeded = true; if (owner.cancelled) void cleanupOwner(owner, 'Late join stopped after cancellation.'); },
        () => { owner.joinSettled = true; if (owner.cancelled) void cleanupOwner(owner, 'Failed join stopped after cancellation.'); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('Worker stopped during join.'));
        if (owner.abort.signal.aborted) cancel(); else owner.abort.signal.addEventListener('abort', cancel, { once: true });
      });
      try {
        await Promise.race([joinPromise, cancelled, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Join timeout exceeded')), joinTimeout + 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); owner.abort.signal.removeEventListener('abort', cancel); }
    } catch (error) {
      await failOwner(owner, error instanceof Error ? error.message : 'Unknown join error');
      return;
    }
    if (closing || owner.cancelled) { await failOwner(owner, 'Worker stopped during join.'); return; }


    // Successfully joined
    await transitionBot(lifecycleDeps, botId, namespace, 'joined');
    await persistMetadataSnapshot(bot, adapter, 'joined');

    if (closing || owner.cancelled) { await failOwner(owner, 'Worker stopped after join.'); return; }
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
        recordingRequired: false,
      });
      setupParticipantMonitoring(bot, adapter);
      setupChatMessagePersistence(bot, adapter, 'joined');
      return;
    }

    // Send consent message before recording (BOT-008, SEC-006)
    const consentMsg =
      bot.config.consentMessage ?? 'This meeting is being recorded';
    await sendConsentMessage(adapter, consentMsg, botId, logger);

    // Transition to recording (only after consent message sent)
    await transitionBot(lifecycleDeps, botId, namespace, 'recording');
    await persistMetadataSnapshot(bot, adapter, 'recording');
    if (closing || owner.cancelled) { await failOwner(owner, 'Worker stopped before capture.'); return; }
    const captureAbort = new AbortController();
    const capturePromise = startCaptureSession(bot, adapter, captureAbort.signal);
    void capturePromise.catch(async (error) => {
      const errorMessage =
        error instanceof Error ? error.message : 'Could not start audio capture.';
      logger.error('recording.capture.failed', {
        botId,
        namespace,
        error: errorMessage,
      });
      await failOwner(owner, errorMessage);
    });
    activeSessions.set(botId, {
      botId,
      namespace,
      adapter,
      capturePromise,
      captureAbort,
      recordingRequired: true,
    });

    // Set up participant monitoring for auto-leave
    setupParticipantMonitoring(bot, adapter);
    setupChatMessagePersistence(bot, adapter, 'recording');

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
      if (
        currentBot &&
        (currentBot.status === 'recording' || currentBot.status === 'joined')
      ) {
        autoLeaveTimer.onParticipantLeave(currentBot, nonBotCount);
      }
    });
  }

  return {
    async cancelCaptures() {
      closing = true;
      autoLeaveTimer.cancelAll();
      const pending = [...owners.values()];
      for (const owner of pending) { owner.cancelled = true; owner.abort.abort(); }
      const cleanup = Promise.all(pending.map(async owner => {
        await failOwner(owner, 'Worker shutdown awaiting provider/capture stop.');
        return cleanupOwner(owner, 'Worker shutdown acknowledged provider and capture stop.');
      }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([cleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, shutdownTimeoutMs); })]); }
      finally { if (timer) clearTimeout(timer); }
      const unresolvedBotIds = [...owners.keys()];
      if (unresolvedBotIds.length) logger.warn('bot.worker.shutdown_uncertain', { botIds: unresolvedBotIds });
      return { unresolvedBotIds };
    },
    async processNext(): Promise<boolean> {
      if (closing || processing) return false;
      processing = true;
      try {
      // Finalization state is durable; a notification consumed by another worker
      // cannot erase the actual owner's obligation to leave/finalize.
      for (const session of activeSessions.values()) {
        const current = await store.getBot(session.botId, session.namespace);
        if (current?.status === 'leaving') {
          await processFinalizeRecordingJob({ type: 'recording.finalize', data: { botId: session.botId, namespace: session.namespace }, createdAt: new Date().toISOString() });
          return true;
        }
      }
      const recover = async (): Promise<boolean> => {
        if (!recoveryNamespaces.length) return false;
        // At most two one-row reads per configured namespace per idle scan.
        // Wrapping a saved cursor cannot hide newly inserted lower IDs.
        for (let checked = 0; checked < recoveryNamespaces.length; checked++) {
          const namespace = recoveryNamespaces[recoveryIndex++ % recoveryNamespaces.length];
          const cursor = recoveryCursors.get(namespace);
          let page = await store.listPendingBotJoins(namespace, 1, cursor);
          if (!page.length && cursor) { recoveryCursors.delete(namespace); page = await store.listPendingBotJoins(namespace, 1); }
          if (!page.length) continue;
          const work = page[0]; recoveryCursors.set(namespace, work.id);
          try { await processJoinJob({ type: 'bot.join', data: { botId: work.id, namespace }, createdAt: work.createdAt }); }
          catch (error) {
            const owner = owners.get(work.id);
            if (owner) await failOwner(owner, String(error)).catch(() => {});
            logger.error('bot.worker.recovery_failed', { botId: work.id, error: String(error) });
            throw error; // Let the host back off instead of spinning on a failed durable intent.
          }
          return true;
        }
        return false;
      };
      recoveryTurn = !recoveryTurn;
      if (recoveryTurn && await recover()) return true;
      const job =
        (await queue.dequeue(QUEUE_NAMES.BOT_JOIN)) ??
        (await queue.dequeue(QUEUE_NAMES.RECORDING_UPLOAD));
      if (!job) return await recover();

      try {
        if (job.type === 'recording.finalize') {
          await processFinalizeRecordingJob(job);
        } else {
          await processJoinJob(job);
        }
      } catch (e) {
        const owner = owners.get(String(job.data.botId));
        if (owner) await failOwner(owner, String(e)).catch(() => {});
        logger.error('bot.worker.error', {
          error: e instanceof Error ? e.message : String(e),
          jobType: job.type,
        });
      }

      return true;
      } finally { processing = false; }
    },

    getAutoLeaveTimer(): AutoLeaveTimer {
      return autoLeaveTimer;
    },
  };
}
