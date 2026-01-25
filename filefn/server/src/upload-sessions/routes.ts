import type { UploadSessionService } from './service.js';
import type { FileFnPrincipal, AuthConfig } from '../auth.js';
import type { RateLimiter } from '@superfunctions/middleware';
import { resolvePrincipal } from '../auth.js';
import { FileFnError, authRequired, rateLimited } from '../errors.js';

export interface RouteContext {
  service: UploadSessionService;
  auth: AuthConfig;
  rateLimiter?: RateLimiter;
}

function getRequestId(request: Request): string | undefined {
  return request.headers.get('x-request-id') || undefined;
}

function getIdempotencyKey(request: Request): string | undefined {
  return request.headers.get('x-idempotency-key') || undefined;
}

function successResponse(data: unknown, requestId?: string, warnings: string[] = []): Response {
  return Response.json(
    { ok: true, data, warnings, requestId },
    { status: 200 }
  );
}

function errorResponse(error: FileFnError, requestId?: string): Response {
  return Response.json(
    { ok: false, error: error.toJSON(), requestId },
    { status: error.statusCode }
  );
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

export function createUploadSessionRoutes(ctx: RouteContext) {
  const { service, auth, rateLimiter } = ctx;

  async function requireAuth(request: Request): Promise<FileFnPrincipal> {
    const principal = await resolvePrincipal(request, auth);
    if (!principal && auth.required !== false) {
      throw authRequired();
    }
    return principal || { principalId: 'anonymous' };
  }

  async function checkRateLimit(key: string, _requestId?: string): Promise<void> {
    if (rateLimiter) {
      const result = await rateLimiter.check(key);
      if (!result.allowed) {
        throw rateLimited(result.resetAt);
      }
    }
  }

  return {
    async initSession(request: Request): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        await checkRateLimit(`upload-init:${principal.principalId}`, requestId);

        const body = await parseJsonBody<{
          policy: string;
          fileName: string;
          size: number;
          mimeType: string;
          fileId?: string;
          metadata?: Record<string, unknown>;
        }>(request);

        const result = await service.createSession(
          { ...body, idempotencyKey: getIdempotencyKey(request) },
          { principalId: principal.principalId, tenantId: principal.tenantId, requestId }
        );

        return successResponse(result, requestId, result.warnings);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },

    async getStatus(request: Request, uploadSessionId: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        const result = await service.getSessionStatus(uploadSessionId, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          requestId,
        });
        return successResponse(result, requestId);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },

    async signPart(request: Request, uploadSessionId: string, partNumber: number): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        await checkRateLimit(`upload-sign:${principal.principalId}`, requestId);

        const body = await parseJsonBody<{ contentLength: number; checksumSha256Base64?: string }>(request);
        const result = await service.signPart(uploadSessionId, partNumber, body.contentLength, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          requestId,
        });
        return successResponse(result, requestId);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },

    async completePart(request: Request, uploadSessionId: string, partNumber: number): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        const body = await parseJsonBody<{ etag: string; size: number; checksumSha256Base64?: string }>(request);

        await service.completePart(uploadSessionId, partNumber, body.etag, body.size, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          requestId,
        });
        return successResponse({ recorded: true }, requestId);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },

    async completeSession(request: Request, uploadSessionId: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        const result = await service.completeSession(uploadSessionId, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          requestId,
        });
        return successResponse(result, requestId);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },

    async abortSession(request: Request, uploadSessionId: string): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await requireAuth(request);
        await service.abortSession(uploadSessionId, {
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          requestId,
        });
        return successResponse({ aborted: true }, requestId);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },
  };
}

export type UploadSessionRoutes = ReturnType<typeof createUploadSessionRoutes>;
