import type { Bot, BotStatus } from 'recfn';
import { assertTransition } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { Logger } from '../integrations/logfn.js';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';
import type { RealtimeTranscriptionPipeline } from '../transcription/realtime.js';

export interface LifecycleDeps {
  store: RecFnStore;
  logger: Logger;
  streamManager?: TranscriptStreamManager;
  realtimePipeline?: RealtimeTranscriptionPipeline;
}

export async function transitionBot(
  deps: LifecycleDeps,
  botId: string,
  namespace: string,
  newStatus: BotStatus,
  errorMessage?: string,
): Promise<Bot | null> {
  const { store, logger, streamManager, realtimePipeline } = deps;

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

  logger.info('bot.status_change', {
    botId,
    from: bot.status,
    to: newStatus,
    ...(errorMessage ? { errorMessage } : {}),
  });

  if (streamManager) {
    streamManager.broadcast(botId, 'status', { status: newStatus });
  }

  if (newStatus === 'leaving' || newStatus === 'left' || newStatus === 'error') {
    if (realtimePipeline) realtimePipeline.stop(botId);
    if (streamManager) streamManager.closeAll(botId, 1000, `Bot transitioned to ${newStatus}`);
  }

  if (newStatus === 'joined' && bot.status === 'joining') {
    const createdAt = new Date(bot.createdAt).getTime();
    const joinedAt = Date.now();
    const latencyMs = joinedAt - createdAt;
    logger.info('bot.join_latency', { botId, latencyMs });
  }

  return updated;
}
