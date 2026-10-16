/**
 * BrowseFn HTTP router using @superfunctions/http.
 */

import { Buffer } from 'node:buffer';

import { createRouter } from '@superfunctions/http/router';
import type { RouteContext, Router } from '@superfunctions/http';

import type { BrowseFn } from '../core/browse-fn.js';
import type { ImageSearchOptions } from '../core/types.js';
import { getOperationResultMeta } from '../core/browse-fn.js';
import {
  BrowseFnError,
  createErrorEnvelope,
  createSuccessEnvelope,
  isBrowseFnError,
} from '../core/errors.js';

interface BrowseFnContext {
  browseFn: BrowseFn;
}

type BrowseFnRouteContext = BrowseFnContext & RouteContext;

function createRequestId(request: Request): string {
  const headerValue = request.headers.get('x-request-id');
  if (headerValue) {
    return headerValue;
  }

  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `browsefn-router-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mapStatus(error: BrowseFnError): number {
  switch (error.code) {
    case 'INVALID_ARGUMENT':
    case 'INVALID_URL':
    case 'UNSUPPORTED_PROVIDER':
    case 'UNSUPPORTED_PROVIDER_CAPABILITY':
      return 400;
    case 'SECURITY_POLICY_BLOCKED':
      return 403;
    case 'UPSTREAM_NOT_FOUND':
      return 404;
    case 'DOWNLOAD_EXISTS':
      return 409;
    case 'DOWNLOAD_TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    case 'PROVIDER_ERROR':
      return 502;
    case 'PROVIDER_UNAVAILABLE':
      return 503;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

function normalizeError(error: unknown): BrowseFnError {
  if (isBrowseFnError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new BrowseFnError({
      code: 'INTERNAL_ERROR',
      message: error.message,
    });
  }

  return new BrowseFnError({
    code: 'INTERNAL_ERROR',
    message: String(error),
  });
}

function respondSuccess(request: Request, data: unknown): Response {
  const requestId = createRequestId(request);
  const meta = getOperationResultMeta(data);

  return Response.json(
    createSuccessEnvelope(serializeData(data), {
      requestId,
      provider: meta?.provider,
      cached: meta?.cached,
      durationMs: meta?.durationMs,
      fallbackFrom: meta?.fallbackFrom,
    }),
    { status: 200 }
  );
}

function respondError(request: Request, error: unknown): Response {
  const requestId = createRequestId(request);
  const browseFnError = normalizeError(error);
  return Response.json(createErrorEnvelope(browseFnError, requestId), {
    status: mapStatus(browseFnError),
  });
}

function serializeData(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => serializeData(item));
  }

  if (!data || typeof data !== 'object') {
    return data;
  }

  const record = { ...(data as Record<string, unknown>) };
  if (record.screenshot instanceof Uint8Array) {
    record.screenshot = Buffer.from(record.screenshot).toString('base64');
  }
  return record;
}

function requireField<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null || value === '') {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: `Missing required field: ${field}`,
    });
  }
  return value;
}

function parseNumberParam(
  value: string | null,
  field: string,
  required = false
): number | undefined {
  if (value === null || value === '') {
    if (required) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: `${field} must be a number.`,
      });
    }
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: `${field} must be a number.`,
    });
  }
  return parsed;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BrowseFnError({
      code: 'INVALID_ARGUMENT',
      message: 'Request body must be valid JSON.',
    });
  }
}

export function createBrowseFnRouter(browseFn: BrowseFn): Router<BrowseFnContext> {
  return createRouter<BrowseFnContext>({
    context: { browseFn },
    routes: [
      {
        method: 'POST',
        path: '/web/page',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const body = await readJsonBody<{ url?: string; options?: Record<string, unknown> }>(
              request
            );
            const page = await ctx.browseFn.web.getPage(
              requireField(body.url, 'url'),
              body.options
            );
            return respondSuccess(request, page);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'POST',
        path: '/web/metadata',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const body = await readJsonBody<{ urls?: string[]; options?: Record<string, unknown> }>(
              request
            );
            if (!Array.isArray(body.urls)) {
              throw new BrowseFnError({
                code: 'INVALID_ARGUMENT',
                message: 'Missing required field: urls',
              });
            }

            const results = await ctx.browseFn.web.getMultipleMetadata(body.urls, body.options);
            return respondSuccess(request, results);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'GET',
        path: '/images/search',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const query = requireField(ctx.query.get('q'), 'q');
            const result = await ctx.browseFn.images.search(query, {
              provider: ctx.query.get('provider') || undefined,
              page: parseNumberParam(ctx.query.get('page'), 'page'),
              perPage: parseNumberParam(ctx.query.get('perPage'), 'perPage'),
              orientation:
                (ctx.query.get('orientation') as ImageSearchOptions['orientation']) || undefined,
              color: ctx.query.get('color') || undefined,
              orderBy: (ctx.query.get('orderBy') as ImageSearchOptions['orderBy']) || undefined,
            });
            return respondSuccess(request, result);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'POST',
        path: '/images/download',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const body = await readJsonBody<{ url?: string; options?: Record<string, unknown> }>(
              request
            );
            const result = await ctx.browseFn.images.download(
              requireField(body.url, 'url'),
              body.options
            );
            return respondSuccess(request, result);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'GET',
        path: '/geo/reverse',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const lat = parseNumberParam(ctx.query.get('lat'), 'lat', true)!;
            const lng = parseNumberParam(ctx.query.get('lng'), 'lng', true)!;
            const result = await ctx.browseFn.geo.reverseGeocode(
              { lat, lng },
              { provider: ctx.query.get('provider') || undefined }
            );
            return respondSuccess(request, result);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'GET',
        path: '/geo/geocode',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const address = requireField(ctx.query.get('address'), 'address');
            const results = await ctx.browseFn.geo.geocode(address, {
              provider: ctx.query.get('provider') || undefined,
              limit: parseNumberParam(ctx.query.get('limit'), 'limit'),
            });
            return respondSuccess(request, results);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'GET',
        path: '/geo/search',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const query = requireField(ctx.query.get('q'), 'q');
            const lat = parseNumberParam(ctx.query.get('lat'), 'lat');
            const lng = parseNumberParam(ctx.query.get('lng'), 'lng');
            const radius = parseNumberParam(ctx.query.get('radius'), 'radius');
            const options: {
              query: string;
              provider?: string;
              radius?: number;
              limit?: number;
              center?: { lat: number; lng: number };
            } = {
              query,
              provider: ctx.query.get('provider') || undefined,
              radius,
              limit: parseNumberParam(ctx.query.get('limit'), 'limit'),
            };

            if (lat !== undefined && lng !== undefined) {
              options.center = { lat, lng };
            }

            const results = await ctx.browseFn.geo.search(options);
            return respondSuccess(request, results);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'GET',
        path: '/geo/places/:id',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const result = await ctx.browseFn.geo.getPlaceDetails(ctx.params.id, {
              provider: ctx.query.get('provider') || undefined,
              fields: ctx.query.get('fields')?.split(',').filter(Boolean),
            });
            return respondSuccess(request, result);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
      {
        method: 'GET',
        path: '/metrics',
        handler: async (request: Request, ctx: BrowseFnRouteContext) => {
          try {
            const metrics = await ctx.browseFn.getMetrics({
              timeRange:
                (ctx.query.get('timeRange') as
                  | 'last-hour'
                  | 'last-24h'
                  | 'last-7d'
                  | 'all'
                  | null) ?? undefined,
              groupBy: (ctx.query.get('groupBy') as 'provider' | null) ?? undefined,
            });
            return respondSuccess(request, metrics);
          } catch (error) {
            return respondError(request, error);
          }
        },
      },
    ],
  });
}
