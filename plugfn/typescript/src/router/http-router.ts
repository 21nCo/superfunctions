/**
 * PlugFn HTTP Router using @superfunctions/http
 *
 * Usage:
 * ```typescript
 * import { createPlugFnRouter } from 'plugfn/router';
 * import { toExpress } from '@superfunctions/http-express';
 *
 * const router = createPlugFnRouter(plug);
 * app.use('/api/plugfn', toExpress(router));
 * ```
 */

import { createRouter, type Router } from '@superfunctions/http';
import type { PlugFn } from '../core/plug-fn.js';

interface PlugFnContext {
  plugFn: PlugFn;
}

/**
 * Create an HTTP router for PlugFn endpoints
 *
 * Returns a @superfunctions/http Router that can be used with any framework adapter.
 *
 * @param plugFn - PlugFn instance
 * @returns Router instance
 */
export function createPlugFnRouter(plugFn: PlugFn): Router<PlugFnContext> {
  return createRouter<PlugFnContext>({
    context: { plugFn },
    routes: [
      // OAuth callback endpoint
      {
        method: 'GET',
        path: '/callback',
        handler: async (_req, ctx) => {
          const { code, state } = Object.fromEntries(ctx.query);

          if (!code || !state) {
            return Response.json({ error: 'Missing code or state' }, { status: 400 });
          }

          try {
            const connection = await ctx.plugFn.connections.handleCallback({
              code,
              state,
            });

            return Response.json({
              success: true,
              connection: {
                id: connection.id,
                provider: connection.provider,
                status: connection.status,
              },
            });
          } catch (error) {
            return Response.json({ error: (error as Error).message }, { status: 400 });
          }
        },
      },

      // Webhook endpoint
      {
        method: 'POST',
        path: '/webhooks/:provider/:event',
        handler: async (req, ctx) => {
          const { provider, event } = ctx.params;

          try {
            const payload = await ctx.json();
            const headers: Record<string, string> = {};
            req.headers.forEach((value, key) => {
              headers[key] = value;
            });

            const webhookEvent = await ctx.plugFn.webhooks.handle(
              provider,
              event,
              payload,
              headers
            );

            return Response.json({
              success: true,
              event: webhookEvent,
            });
          } catch (error) {
            return Response.json({ error: (error as Error).message }, { status: 400 });
          }
        },
      },

      // List providers
      {
        method: 'GET',
        path: '/providers',
        handler: async (_req, ctx) => {
          const providers = ctx.plugFn.providers.list();

          return Response.json({
            providers: providers.map((p) => ({
              name: p.name,
              displayName: p.displayName,
              description: p.description,
              authType: p.auth.type,
            })),
          });
        },
      },

      // List connections
      {
        method: 'GET',
        path: '/connections',
        handler: async (_req, ctx) => {
          const userId = ctx.query.get('userId');
          const provider = ctx.query.get('provider');

          if (!userId) {
            return Response.json({ error: 'Missing userId' }, { status: 400 });
          }

          const connections = await ctx.plugFn.connections.list({
            userId,
            provider: provider || undefined,
          });

          return Response.json({ connections });
        },
      },

      // Get auth URL
      {
        method: 'POST',
        path: '/connections/auth',
        handler: async (_req, ctx) => {
          const body = await ctx.json();
          const { userId, provider, redirectUri, scopes, connectionName } = body;

          if (!userId || !provider || !redirectUri) {
            return Response.json(
              { error: 'Missing required fields: userId, provider, redirectUri' },
              { status: 400 }
            );
          }

          // Generate a random state for OAuth security
          const state =
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);

          const authUrl = await ctx.plugFn.connections.getAuthUrl({
            userId,
            provider,
            redirectUri,
            scopes,
            connectionName,
            state,
          });

          return Response.json({ authUrl });
        },
      },

      // Disconnect
      {
        method: 'POST',
        path: '/connections/disconnect',
        handler: async (_req, ctx) => {
          const body = await ctx.json();
          const { userId, provider, connectionId } = body;

          if (!userId || !provider) {
            return Response.json(
              { error: 'Missing required fields: userId, provider' },
              { status: 400 }
            );
          }

          await ctx.plugFn.connections.disconnect({
            userId,
            provider,
            connectionId,
          });

          return Response.json({ success: true });
        },
      },

      // List workflows
      {
        method: 'GET',
        path: '/workflows',
        handler: async (_req, ctx) => {
          const userId = ctx.query.get('userId');
          const status = ctx.query.get('status');

          const workflows = await ctx.plugFn.workflows.list({
            userId: userId || undefined,
            status: status as any,
          });

          return Response.json({ workflows });
        },
      },

      // Get metrics
      {
        method: 'GET',
        path: '/metrics',
        handler: async (_req, ctx) => {
          const timeRange = ctx.query.get('timeRange');
          const groupBy = ctx.query.get('groupBy');

          const metrics = await ctx.plugFn.getMetrics({
            timeRange: timeRange as any,
            groupBy: groupBy as any,
          });

          return Response.json({ metrics });
        },
      },
    ],
  });
}
