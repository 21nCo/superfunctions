import type { Route, RouteContext } from '@superfunctions/http';
import {
  ErrorCode,
  validateMeetingUrl,
  validateBotConfig,
  isTerminalState,
  canTransition,
} from 'recfn';
import type { RecFnStore, ListBotsOptions } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import type { BotStatus, Platform } from 'recfn';

export interface BotRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  queue?: QueueAdapter;
  logger?: Logger;
}

export function createBotRoutes(deps: BotRouteDeps): Route[] {
  const { store, validateApiKey } = deps;

  return [
    {
      method: 'POST',
      path: '/api/v1/bots',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
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
        if (limit > 100) {
          return err(
            ErrorCode.BAD_REQUEST,
            'limit must be between 1 and 100.',
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
        return ok(bot);
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

        await store.updateBot(bot.id, auth.namespace, {
          status: 'leaving',
        });

        return ok({ botId: bot.id, status: 'leaving' });
      },
    },

    {
      method: 'DELETE',
      path: '/api/v1/bots/:botId',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);

        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }

        if (!isTerminalState(bot.status) && bot.status !== 'left') {
          return err(
            ErrorCode.BOT_STILL_ACTIVE,
            'Cannot delete bot while it is active. Call leave first.',
          );
        }

        await store.deleteBot(bot.id, auth.namespace);
        return ok({ botId: bot.id, deleted: true });
      },
    },
  ];
}
