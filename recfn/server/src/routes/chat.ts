import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface ChatRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
}

export function createChatRoutes(deps: ChatRouteDeps): Route[] {
  const { store, validateApiKey } = deps;

  return [
    {
      method: 'GET',
      path: '/api/v1/bots/:botId/chat',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);
        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }
        const messages = await store.getChatMessages(
          ctx.params.botId,
          auth.namespace,
        );
        return ok({ messages });
      },
    },
  ];
}
