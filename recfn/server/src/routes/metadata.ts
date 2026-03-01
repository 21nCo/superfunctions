import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface MetadataRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
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
        if (!meta) {
          return ok({
            id: '',
            botId: ctx.params.botId,
            platform: bot.platform,
            chatMessages: [],
          });
        }
        return ok(meta);
      },
    },
  ];
}
