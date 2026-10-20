import { deleteBotAggregate } from '../deletion/service.js';
import type { StorageAdapter } from '../integrations/storage.js';
import type { SearchFnClient } from '../integrations/searchfn.js';
import type { Route, RouteContext } from '@superfunctions/http';
import {
  ErrorCode,
  validateMeetingUrl,
  validateBotConfig,
  canTransition,
} from '@recfn/core';
import type { RecFnStore, ListBotsOptions } from '../store/types.js';
import { checkConcurrentBots, checkPaginationLimit } from '../middleware/limits.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import { transitionBot } from '../worker/lifecycle.js';
import { assertRealtimeTranscriptionSupported } from '../transcription/realtime.js';
import type {
  Bot,
  BotStatus,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Platform,
  Recording,
} from '@recfn/core';

export interface BotRouteDeps {
  storage?: StorageAdapter;
  searchClient?: SearchFnClient | null;
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  limits: import('../config.js').RecFnLimitsConfig;
  queue?: QueueAdapter;
  logger?: Logger;
}

type AggregateBotView = Bot & {
  participants: Participant[];
  recordings: Recording[];
  metadata: MeetingMetadata | null;
  chatMessages: ChatMessage[];
};

export function createBotRoutes(deps: BotRouteDeps): Route[] {
  const { store, validateApiKey, limits } = deps;

  return [
    {
      method: 'POST',
      path: '/api/v1/bots',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        await checkConcurrentBots(store, auth.namespace, limits);
        const body = await ctx.json<{
          meetingUrl?: string;
          platform?: Platform;
          config?: Record<string, unknown>;
        }>();

        if (!body.meetingUrl || typeof body.meetingUrl !== 'string') {
          return err(ErrorCode.BAD_REQUEST, 'meetingUrl is required.');
        }

        const { platform } = validateMeetingUrl(
          body.meetingUrl,
          body.platform,
        );
        const config = validateBotConfig(
          body.config as Parameters<typeof validateBotConfig>[0],
        );
        if (config.enableRealTimeTranscript) {
          assertRealtimeTranscriptionSupported(platform, config.asrProvider);
        }

        const bot = await store.createBot({
          meetingUrl: body.meetingUrl,
          platform,
          config,
          namespace: auth.namespace,
        });

        if (deps.queue) {
          await deps.queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
            type: 'bot.join',
            data: { botId: bot.id, namespace: auth.namespace },
            createdAt: new Date().toISOString(),
          });
        }

        if (deps.logger) {
          deps.logger.info('bot.created', {
            botId: bot.id,
            platform,
            namespace: auth.namespace,
          });
        }

        return ok(bot, 201);
      },
    },

    {
      method: 'GET',
      path: '/api/v1/bots',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);

        const limitParam = ctx.query.get('limit');
        const cursor = ctx.query.get('cursor') ?? undefined;
        const status = ctx.query.get('status') as BotStatus | undefined;
        const platform = ctx.query.get('platform') as Platform | undefined;

        let limit = limitParam ? parseInt(limitParam, 10) : 20;
        if (isNaN(limit) || limit < 1) limit = 20;
        try {
          checkPaginationLimit(limit, limits);
        } catch (e) {
          return err(
            (e as import('@recfn/core').RecFnError).code,
            (e as Error).message,
          );
        }

        const opts: ListBotsOptions = { limit, cursor, status, platform };
        const result = await store.listBots(auth.namespace, opts);

        return ok({
          bots: result.items,
          nextCursor: result.nextCursor ?? null,
        });
      },
    },

    {
      method: 'GET',
      path: '/api/v1/bots/:botId',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);
        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }
        const [participants, recordings, metadata, chatMessages] =
          await Promise.all([
            store.getParticipants(bot.id, auth.namespace),
            store.getRecordings(bot.id, auth.namespace),
            store.getMetadata(bot.id, auth.namespace),
            store.getChatMessages(bot.id, auth.namespace),
          ]);

        const aggregate: AggregateBotView = {
          ...bot,
          participants,
          recordings,
          metadata,
          chatMessages,
        };

        return ok(aggregate);
      },
    },

    {
      method: 'POST',
      path: '/api/v1/bots/:botId/leave',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);

        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }

        if (
          bot.status === 'done' ||
          bot.status === 'left' ||
          bot.status === 'leaving'
        ) {
          if (bot.status === 'leaving') {
            return ok({ botId: bot.id, status: 'leaving' });
          }
          return err(
            ErrorCode.BOT_ALREADY_LEFT,
            'Bot has already left the meeting.',
          );
        }

        if (!canTransition(bot.status, 'leaving')) {
          return err(
            ErrorCode.BAD_REQUEST,
            `Cannot leave bot in ${bot.status} status.`,
          );
        }

        await transitionBot(
          {
            store,
            logger: deps.logger ?? { info() {}, warn() {}, error() {} },
            queue: deps.queue,
          },
          bot.id,
          auth.namespace,
          'leaving',
        );

        const existingMetadata = await store.getMetadata(bot.id, auth.namespace);
        const now = new Date().toISOString();
        await store.upsertMetadata(
          bot.id,
          {
            id: existingMetadata?.id ?? `meta_${bot.id}`,
            botId: bot.id,
            title: existingMetadata?.title,
            startTime: existingMetadata?.startTime,
            endTime: existingMetadata?.endTime ?? now,
            platform: existingMetadata?.platform ?? bot.platform,
            chatMessages:
              existingMetadata?.chatMessages ??
              (await store.getChatMessages(bot.id, auth.namespace)),
          },
          auth.namespace,
        );

        return ok({ botId: bot.id, status: 'leaving' });
      },
    },

    {
      method: 'DELETE',
      path: '/api/v1/bots/:botId',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const result = await deleteBotAggregate(ctx.params.botId, auth.namespace, deps);
        if (!result) return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        return ok({ botId: ctx.params.botId, ...result }, result.deleted ? 200 : 202);
      },
    },
  ];
}
