import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from '@recfn/core';
import { WEBHOOK_EVENTS } from '../webhooks/events.js';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { checkWebhookCount } from '../middleware/limits.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface WebhookRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  limits: import('../config.js').RecFnLimitsConfig;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createWebhookRoutes(deps: WebhookRouteDeps): Route[] {
  const { store, validateApiKey, limits } = deps;

  return [
    {
      method: 'POST',
      path: '/api/v1/webhooks',
      handler: async (request: Request, _ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const url = body.url as string | undefined;
        const events = body.events as string[] | undefined;
        const secret = body.secret as string | undefined;

        if (!url || typeof url !== 'string' || !url.trim()) {
          return err(ErrorCode.BAD_REQUEST, 'url is required.');
        }
        if (!isValidUrl(url)) {
          return err(ErrorCode.BAD_REQUEST, 'url must be a valid http or https URL.');
        }
        if (!Array.isArray(events) || events.length === 0) {
          return err(ErrorCode.BAD_REQUEST, 'events must be a non-empty array.');
        }
        const invalidEvents = events.filter((e) => !WEBHOOK_EVENTS.includes(e as (typeof WEBHOOK_EVENTS)[number]));
        if (invalidEvents.length > 0) {
          return err(
            ErrorCode.BAD_REQUEST,
            `Invalid events: ${invalidEvents.join(', ')}. Valid: ${WEBHOOK_EVENTS.join(', ')}`,
          );
        }

        try {
          await checkWebhookCount(store, auth.namespace, limits);
        } catch (e) {
          return err(
            (e as import('@recfn/core').RecFnError).code,
            (e as Error).message,
          );
        }

        const webhook = await store.createWebhook(
          {
            url: url.trim(),
            events: [...events],
            secret: secret?.trim() || undefined,
          },
          auth.namespace,
        );

        const { secret: _s, ...publicWebhook } = webhook;
        return ok(publicWebhook, 201);
      },
    },

    {
      method: 'GET',
      path: '/api/v1/webhooks',
      handler: async (request: Request, _ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const webhooks = await store.listWebhooks(auth.namespace);
        const publicWebhooks = webhooks.map(({ secret: _s, ...rest }) => rest);
        return ok({ webhooks: publicWebhooks });
      },
    },

    {
      method: 'DELETE',
      path: '/api/v1/webhooks/:webhookId',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const webhook = await store.getWebhook(ctx.params.webhookId, auth.namespace);
        if (!webhook) {
          return err(ErrorCode.WEBHOOK_NOT_FOUND, 'Webhook not found.');
        }
        await store.deleteWebhook(ctx.params.webhookId, auth.namespace);
        return ok({ webhookId: ctx.params.webhookId, deleted: true });
      },
    },
  ];
}
