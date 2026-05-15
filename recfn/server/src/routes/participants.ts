import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface ParticipantRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
}

export function createParticipantRoutes(deps: ParticipantRouteDeps): Route[] {
  const { store, validateApiKey } = deps;

  return [
    {
      method: 'GET',
      path: '/api/v1/bots/:botId/participants',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);
        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }
        const participants = await store.getParticipants(
          ctx.params.botId,
          auth.namespace,
        );
        return ok({ participants });
      },
    },
  ];
}
