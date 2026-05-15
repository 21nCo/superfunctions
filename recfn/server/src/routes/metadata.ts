import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode, type Bot, type MeetingMetadata } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface MetadataRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
}

function createPlaceholderMetadata(bot: Bot): MeetingMetadata {
  return {
    id: bot.id,
    botId: bot.id,
    platform: bot.platform,
    chatMessages: [],
  };
}

export function createMetadataRoutes(deps: MetadataRouteDeps): Route[] {
  const { store, validateApiKey } = deps;

  return [
    {
      method: 'GET',
      path: '/api/v1/bots/:botId/metadata',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);
        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }
        const meta = await store.getMetadata(
          ctx.params.botId,
          auth.namespace,
        );
        return ok(meta ?? createPlaceholderMetadata(bot));
      },
    },
  ];
}
