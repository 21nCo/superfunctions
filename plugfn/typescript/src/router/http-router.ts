import { randomBytes } from 'node:crypto';
import { createRouter, type Middleware, type Route, type Router } from '@superfunctions/http';
import type { PlugFn } from '../core/plug-fn.js';
import type { PlugFnPrincipal } from '../types/config.js';

export interface RouteAuthContext {
  userId: string;
  tenantId?: string;
}

export interface PlugFnRouterOptions {
  authenticate?: (request: Request) => Promise<RouteAuthContext | null> | RouteAuthContext | null;
  webhookSecret?:
    | Record<string, string>
    | ((
        provider: string,
        request: Request,
        headers: Record<string, string>
      ) => Promise<string | undefined> | string | undefined);
  maxWebhookPayloadBytes?: number;
}

interface PlugFnContext {
  plugFn: PlugFn;
  authContext?: RouteAuthContext;
}

interface DeterministicError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  details: Record<string, unknown>;
}

interface ParseJsonBodyOptions {
  maxBytes?: number;
}

const DEFAULT_WEBHOOK_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export function createPlugFnRouter(
  plugFn: PlugFn,
  options: PlugFnRouterOptions = {}
): Router<PlugFnContext> {
  const maxWebhookPayloadBytes = options.maxWebhookPayloadBytes ?? DEFAULT_WEBHOOK_PAYLOAD_MAX_BYTES;
  const authenticate = options.authenticate ?? plugFn.config.auth.authenticate;

  const requireAuth: Middleware<PlugFnContext> = async (request, context, next) => {
    try {
      const authContext = await resolveAuthContext(request, authenticate);
      if (!authContext) {
        return errorResponse({
          code: 'PLUGFN_AUTH_REQUIRED',
          message: 'authentication required',
          status: 401,
          retryable: false,
          details: {},
        });
      }

      context.authContext = authContext;
      assertIdentityMatchesQuery(new URL(request.url).searchParams, authContext);
      return next();
    } catch (error) {
      return errorResponse(toDeterministicError(error));
    }
  };

  const routes: Route<PlugFnContext>[] = withV2Routes([
    {
      method: 'GET',
      path: '/callback',
      handler: async (_req, ctx) => {
        const { code, state } = Object.fromEntries(ctx.query);

        if (!code || !state) {
          return errorResponse({
            code: 'VALIDATION_ERROR',
            message: 'missing code or state',
            status: 400,
            retryable: false,
            details: {},
          });
        }

        try {
          const connection = await ctx.plugFn.connections.handleCallback({
            code,
            state,
          });

          return successResponse({
            connection: {
              id: connection.id,
              provider: connection.provider,
              status: connection.status,
            },
          });
        } catch (error) {
          return errorResponse(toDeterministicError(error));
        }
      },
    },
    {
      method: 'POST',
      path: '/webhooks/:provider/:event',
      handler: async (req, ctx) => {
        const { provider, event } = ctx.params;

        try {
          const rawBody = await readRequestBytes(req, { maxBytes: maxWebhookPayloadBytes });
          const headers = normalizeHeaders(req.headers);
          const secret = await resolveWebhookSecret(provider, req, headers, options.webhookSecret);

          const webhookEvent = await ctx.plugFn.webhooks.handle(
            provider,
            event,
            undefined,
            headers,
            secret,
            { rawBody }
          );

          return successResponse({
            event: webhookEvent,
          });
        } catch (error) {
          return errorResponse(toDeterministicError(error));
        }
      },
    },
    {
      method: 'GET',
      path: '/providers',
      middleware: [requireAuth],
      handler: async (_req, ctx) => {
        const providers = ctx.plugFn.providers.list();

        return successResponse({
          providers: providers.map((provider) => ({
            name: provider.name,
            displayName: provider.displayName,
            description: provider.description,
            authType: provider.auth.type,
          })),
        });
      },
    },
    {
      method: 'GET',
      path: '/connections',
      middleware: [requireAuth],
      handler: async (_req, ctx) => {
        const provider = ctx.query.get('provider');
        const authContext = requireAuthContext(ctx);

        const connections = await ctx.plugFn.connections.list({
          userId: authContext.userId,
          provider: provider || undefined,
        });

        return successResponse({
          connections,
          userId: authContext.userId,
        });
      },
    },
    {
      method: 'POST',
      path: '/connections/auth',
      middleware: [requireAuth],
      handler: async (req, ctx) => {
        try {
          const body = await parseJsonBody(req);
          const authContext = requireAuthContext(ctx);
          assertIdentityMatches(body, authContext);

          const provider = asString(body.provider);
          const redirectUri = asString(body.redirectUri);
          const scopes = asStringArray(body.scopes);
          const connectionName = asOptionalString(body.connectionName);

          if (!provider || !redirectUri) {
            return errorResponse({
              code: 'VALIDATION_ERROR',
              message: 'missing required fields: provider, redirectUri',
              status: 400,
              retryable: false,
              details: {},
            });
          }

          const authUrl = await ctx.plugFn.connections.getAuthUrl({
            userId: authContext.userId,
            provider,
            redirectUri,
            scopes,
            connectionName,
          });

          return successResponse({
            authUrl,
          });
        } catch (error) {
          return errorResponse(toDeterministicError(error));
        }
      },
    },
    {
      method: 'POST',
      path: '/connections/disconnect',
      middleware: [requireAuth],
      handler: async (req, ctx) => {
        try {
          const body = await parseJsonBody(req);
          const authContext = requireAuthContext(ctx);
          assertIdentityMatches(body, authContext);

          const provider = asString(body.provider);
          const connectionId = asOptionalString(body.connectionId);

          if (!provider) {
            return errorResponse({
              code: 'VALIDATION_ERROR',
              message: 'missing required field: provider',
              status: 400,
              retryable: false,
              details: {},
            });
          }

          await ctx.plugFn.connections.disconnect({
            userId: authContext.userId,
            provider,
            connectionId,
          });

          return successResponse({
            success: true,
          });
        } catch (error) {
          return errorResponse(toDeterministicError(error));
        }
      },
    },
    {
      method: 'GET',
      path: '/workflows',
      middleware: [requireAuth],
      handler: async (_req, ctx) => {
        const status = asOptionalString(ctx.query.get('status'));
        const authContext = requireAuthContext(ctx);

        const workflows = await ctx.plugFn.workflows.list({
          userId: authContext.userId,
          status: status as any,
        });

        return successResponse({
          workflows,
        });
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      middleware: [requireAuth],
      handler: async (_req, ctx) => {
        const timeRange = asOptionalString(ctx.query.get('timeRange'));
        const groupBy = asOptionalString(ctx.query.get('groupBy'));
        const provider = asOptionalString(ctx.query.get('provider'));
        const authContext = requireAuthContext(ctx);

        const metrics = await ctx.plugFn.getMetrics({
          timeRange: timeRange as any,
          groupBy: groupBy as any,
          provider,
          userId: authContext.userId,
        });

        return successResponse({
          metrics,
        });
      },
    },
  ]);

  return createRouter<PlugFnContext>({
    context: { plugFn },
    routes,
  });
}

function requireAuthContext(context: PlugFnContext): RouteAuthContext {
  if (!context.authContext) {
    throw {
      code: 'PLUGFN_AUTH_REQUIRED',
      message: 'authentication required',
      status: 401,
    };
  }

  return context.authContext;
}

async function resolveAuthContext(
  request: Request,
  authenticate?: PlugFnRouterOptions['authenticate']
): Promise<RouteAuthContext | null> {
  if (!authenticate) {
    return null;
  }

  return normalizeAuthContext(await authenticate(request));
}

async function resolveWebhookSecret(
  provider: string,
  request: Request,
  headers: Record<string, string>,
  resolver: PlugFnRouterOptions['webhookSecret']
): Promise<string | undefined> {
  if (!resolver) {
    return undefined;
  }

  if (typeof resolver === 'function') {
    return await resolver(provider, request, headers);
  }

  return resolver[provider];
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

async function parseJsonBody(
  request: Request,
  options: ParseJsonBodyOptions = {}
): Promise<Record<string, any>> {
  return parseJsonText(await readRequestText(request, options));
}

async function readRequestBytes(
  request: Request,
  options: ParseJsonBodyOptions = {}
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined) {
    const contentLength = parseContentLength(request.headers.get('content-length'));
    if (contentLength !== undefined && contentLength > maxBytes) {
      throw payloadTooLargeError(maxBytes);
    }
  }

  try {
    const body = new Uint8Array(await request.arrayBuffer());
    if (maxBytes !== undefined && body.byteLength > maxBytes) {
      throw payloadTooLargeError(maxBytes);
    }
    return body;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in (error as any) &&
      'status' in (error as any)
    ) {
      throw error;
    }
    return new Uint8Array();
  }
}

async function readRequestText(
  request: Request,
  options: ParseJsonBodyOptions = {}
): Promise<string> {
  const body = await readRequestBytes(request, options);
  return new TextDecoder().decode(body);
}

function parseJsonText(body: string): Record<string, any> {
  try {
    if (!body) {
      return {};
    }

    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed as Record<string, any>;
  } catch {
    return {};
  }
}

function assertIdentityMatches(body: Record<string, any>, authContext: RouteAuthContext): void {
  const bodyUserId = asOptionalString(body.userId);
  if (bodyUserId && bodyUserId !== authContext.userId) {
    throw {
      code: 'TENANT_ACCESS_DENIED',
      message: 'identity mismatch',
      status: 403,
    };
  }

  const bodyTenantId = asOptionalString(body.tenantId);
  if (bodyTenantId && authContext.tenantId && bodyTenantId !== authContext.tenantId) {
    throw {
      code: 'TENANT_ACCESS_DENIED',
      message: 'identity mismatch',
      status: 403,
    };
  }
}

function assertIdentityMatchesQuery(
  query: URLSearchParams,
  authContext: RouteAuthContext
): void {
  assertIdentityMatches(
    {
      userId: query.get('user') ?? query.get('uid') ?? Object.fromEntries(query).userId,
      tenantId: Object.fromEntries(query).tenantId,
    },
    authContext
  );
}

function normalizeAuthContext(principal: PlugFnPrincipal | null): RouteAuthContext | null {
  if (!principal) {
    return null;
  }

  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value.filter((entry): entry is string => {
    return typeof entry === 'string' && entry.length > 0;
  });

  return result.length > 0 ? result : undefined;
}

function toDeterministicError(error: unknown): DeterministicError {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error &&
    typeof (error as any).code === 'string' &&
    typeof (error as any).message === 'string'
  ) {
    const status =
      'status' in (error as any) && typeof (error as any).status === 'number'
        ? (error as any).status
        : 400;
    const retryable =
      'retryable' in (error as any) && typeof (error as any).retryable === 'boolean'
        ? (error as any).retryable
        : isRetryableStatus(status);
    const details =
      'details' in (error as any) && isPlainObject((error as any).details)
        ? ((error as any).details as Record<string, unknown>)
        : {};

    return {
      code: (error as any).code,
      message: (error as any).message,
      status,
      retryable,
      details,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'VALIDATION_ERROR',
      message: error.message,
      status: 400,
      retryable: false,
      details: {},
    };
  }

  return {
    code: 'VALIDATION_ERROR',
    message: 'request failed',
    status: 400,
    retryable: false,
    details: {},
  };
}

function successResponse(data: Record<string, unknown>): Response {
  return Response.json({
    ok: true,
    data,
    meta: createResponseMeta(),
  });
}

function errorResponse(error: DeterministicError): Response {
  const details = isPlainObject(error.details) ? error.details : {};
  return Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable,
        details,
      },
      meta: createResponseMeta(),
    },
    { status: error.status }
  );
}

function createResponseMeta(): { requestId: string; timestamp: string } {
  return {
    requestId: `req_${randomBytes(12).toString('hex')}`,
    timestamp: new Date().toISOString(),
  };
}

function withV2Routes(routes: Route<PlugFnContext>[]): Route<PlugFnContext>[] {
  return [
    ...routes,
    ...routes.map((route) => ({
      ...route,
      path: withV2Prefix(route.path),
      middleware: route.middleware ? [...route.middleware] : undefined,
    })),
  ];
}

function withV2Prefix(path: string): string {
  if (path === '/') {
    return '/v2';
  }
  if (path.startsWith('/v2/')) {
    return path;
  }
  return `/v2${path}`;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function payloadTooLargeError(maxBytes: number): DeterministicError {
  return {
    code: 'VALIDATION_ERROR',
    message: 'webhook payload exceeds configured max size',
    status: 413,
    retryable: false,
    details: {
      maxBytes,
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
