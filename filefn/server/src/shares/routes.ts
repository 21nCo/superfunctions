import type { SharesService } from './service.js';
import type { FileFnPrincipal, AuthConfig } from '../auth.js';
import type { RateLimiter } from '@superfunctions/middleware';
import { isAnonymousPrincipal, resolvePrincipal } from '../auth.js';
import { FileFnError, authRequired, rateLimited } from '../errors.js';
import { rateLimitSubject, type RateLimitCategory, type RateLimitClientKey } from '../rate-limit-key.js';
import { buildDownloadHeaders } from '../download-headers.js';
import { readJsonBody } from '../http-body.js';

export interface SharesRouteContext {
  service: SharesService;
  auth: AuthConfig;
  rateLimiter?: RateLimiter;
  rateLimits?: {
    shareDownload?: RateLimitCategory;
    shareCreate?: RateLimitCategory;
  };
  clientKey?: RateLimitClientKey;
}

function getRequestId(request: Request): string | undefined {
  return request.headers.get('x-request-id') || undefined;
}

function successResponse(data: unknown, requestId?: string): Response {
  return Response.json({ ok: true, data, requestId }, { status: 200 });
}

function createdResponse(data: unknown, requestId?: string): Response {
  return Response.json({ ok: true, data, requestId }, { status: 201 });
}

function errorResponse(error: FileFnError, requestId?: string): Response {
  return Response.json({ ok: false, error: error.toJSON(), requestId }, { status: error.statusCode });
}

export function createSharesRoutes(ctx: SharesRouteContext) {
  const { service, auth, rateLimiter, rateLimits, clientKey } = ctx;

  async function requireAuth(request: Request): Promise<FileFnPrincipal> {
    const principal = await resolvePrincipal(request, auth);
    if (!principal && auth.required !== false) {
      throw authRequired();
    }
    return principal || { principalId: 'anonymous' };
  }

  async function optionalAuth(request: Request): Promise<FileFnPrincipal | null> {
    return resolvePrincipal(request, auth);
  }

  async function checkRateLimit(
    request: Request,
    category: string,
    principal: FileFnPrincipal | null,
    categoryLimit?: { windowSeconds: number; maxRequests: number }
  ): Promise<void> {
    if (!rateLimiter || !categoryLimit) {
      return;
    }

    const result = await rateLimiter.check({
      key: `${category}:${await rateLimitSubject(principal, request, clientKey)}`,
      windowSeconds: categoryLimit.windowSeconds,
      limit: categoryLimit.maxRequests,
    });
    if (!result.allowed) {
      throw rateLimited(result.resetAt);
    }
  }

  return {
    async createShareLink(request: Request, fileId: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        await checkRateLimit(request, 'share-create', principal, rateLimits?.shareCreate);
        const body = await readJsonBody(request) as {
          versionId?: string;
          expiresAt?: string;
          requiresAuth?: boolean;
          maxDownloads?: number;
        };

        const result = await service.createShareLink(
          {
            fileId,
            versionId: body.versionId,
            expiresAt: body.expiresAt,
            requiresAuth: body.requiresAuth,
            maxDownloads: body.maxDownloads,
          },
          { principalId: principal.principalId, tenantId: principal.tenantId, roles: principal.roles, requestId }
        );

        return createdResponse(result, requestId);
      } catch (err) {
        if (err instanceof FileFnError) return errorResponse(err, requestId);
        throw err;
      }
    },

    async downloadViaShareLink(request: Request, token: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await optionalAuth(request);
        await checkRateLimit(request, 'share-download', principal, rateLimits?.shareDownload);

        const result = await service.downloadViaShareLink(token, {
          principalId: principal?.principalId || 'anonymous',
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          isAuthenticated: !isAnonymousPrincipal(principal),
          requestId,
        });

        return successResponse({
          url: result.url,
          headers: result.headers,
          fileName: result.fileName,
          mimeType: result.mimeType,
        }, requestId);
      } catch (err) {
        if (err instanceof FileFnError) return errorResponse(err, requestId);
        throw err;
      }
    },

    async proxyDownloadViaShareLink(request: Request, token: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await optionalAuth(request);
        await checkRateLimit(request, 'share-download', principal, rateLimits?.shareDownload);

        const result = await service.getDownloadStreamViaShareLink(token, {
          principalId: principal?.principalId || 'anonymous',
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          isAuthenticated: !isAnonymousPrincipal(principal),
          requestId,
        });

        return new Response(result.stream, {
          status: 200,
          headers: buildDownloadHeaders(result),
        });
      } catch (err) {
        if (err instanceof FileFnError) return errorResponse(err, requestId);
        throw err;
      }
    },

    async revokeShareLink(request: Request, fileId: string, token: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        await service.revokeShareLink(fileId, token, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          roles: principal.roles,
          requestId,
        });

        return successResponse({ revoked: true }, requestId);
      } catch (err) {
        if (err instanceof FileFnError) return errorResponse(err, requestId);
        throw err;
      }
    },

    async listShareLinks(request: Request, fileId: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        const shares = await service.listShareLinks(fileId, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          roles: principal.roles,
          requestId,
        });

        return successResponse({ shares }, requestId);
      } catch (err) {
        if (err instanceof FileFnError) return errorResponse(err, requestId);
        throw err;
      }
    },
  };
}

export type SharesRoutes = ReturnType<typeof createSharesRoutes>;
