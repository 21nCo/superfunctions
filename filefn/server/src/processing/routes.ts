import type { ProcessingService } from './service.js';
import type { AuthConfig } from '../auth.js';
import type { RateLimiter } from '@superfunctions/middleware';
import { resolvePrincipal } from '../auth.js';
import * as errors from '../errors.js';

export interface ProcessingRoutesConfig {
  service: ProcessingService;
  auth: AuthConfig;
  rateLimiter?: RateLimiter;
  rateLimits?: {
    artifactDownload?: {
      windowSeconds: number;
      maxRequests: number;
    };
  };
}

export interface ProcessingRouteContext {
  requestId?: string;
}

function getRequestId(request: Request): string | undefined {
  return request.headers.get('x-request-id') || undefined;
}

function jsonResponse(data: unknown, requestId?: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
      warnings: [],
      requestId,
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    }
  );
}

function errorResponse(error: errors.FileFnError, requestId?: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details || {},
      },
      requestId,
    }),
    {
      status: error.status,
      headers: { 'content-type': 'application/json' },
    }
  );
}

export function createProcessingRoutes(config: ProcessingRoutesConfig) {
  const { service, auth, rateLimiter, rateLimits } = config;

  async function checkArtifactDownloadRateLimit(
    principal: { principalId?: string; tenantId?: string } | null
  ): Promise<void> {
    const categoryLimit = rateLimits?.artifactDownload;
    if (!rateLimiter || !categoryLimit) {
      return;
    }

    const result = await rateLimiter.check({
      key: `artifact-download:${principal?.tenantId || 'global'}:${principal?.principalId || 'anonymous'}`,
      windowSeconds: categoryLimit.windowSeconds,
      limit: categoryLimit.maxRequests,
    });
    if (!result.allowed) {
      throw errors.rateLimited(result.resetAt);
    }
  }

  return {
    async listArtifacts(request: Request, fileId: string): Promise<Response> {
      const requestId = getRequestId(request);

      try {
        const principal = await resolvePrincipal(request, auth);
        await checkArtifactDownloadRateLimit(principal);
        const ctx = {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          requestId,
        };

        const artifacts = await service.listArtifactsForFile(fileId, ctx);

        return jsonResponse(
          {
            artifacts: artifacts.map((a) => ({
              artifactId: a.artifactId,
              fileId: a.fileId,
              versionId: a.versionId,
              kind: a.kind,
              mimeType: a.mimeType,
              size: a.size,
              createdAt: a.createdAt,
            })),
          },
          requestId
        );
      } catch (error) {
        if (error instanceof errors.FileFnError) {
          return errorResponse(error, requestId);
        }
        throw error;
      }
    },

    async downloadArtifact(request: Request, fileId: string, artifactId: string): Promise<Response> {
      const requestId = getRequestId(request);

      try {
        const principal = await resolvePrincipal(request, auth);
        await checkArtifactDownloadRateLimit(principal);
        const ctx = {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          requestId,
        };

        const { url, headers } = await service.getArtifactDownloadUrlForFile(fileId, artifactId, ctx);

        return jsonResponse({ url, headers }, requestId);
      } catch (error) {
        if (error instanceof errors.FileFnError) {
          return errorResponse(error, requestId);
        }
        throw error;
      }
    },

    async proxyDownloadArtifact(request: Request, fileId: string, artifactId: string): Promise<Response> {
      const requestId = getRequestId(request);

      try {
        const principal = await resolvePrincipal(request, auth);
        const ctx = {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          requestId,
        };

        const result = await service.getArtifactDownloadStreamForFile(fileId, artifactId, ctx);

        return new Response(result.stream, {
          status: 200,
          headers: {
            'Content-Type': result.contentType,
            'Content-Length': result.size.toString(),
          },
        });
      } catch (error) {
        if (error instanceof errors.FileFnError) {
          return errorResponse(error, requestId);
        }
        throw error;
      }
    },

    async triggerProcessing(request: Request, fileId: string): Promise<Response> {
      const requestId = getRequestId(request);

      try {
        const principal = await resolvePrincipal(request, auth);

        if (!principal && auth.required) {
          throw errors.authRequired();
        }

        const ctx = {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          requestId,
        };

        const body = (await request.json()) as {
          versionId?: string;
          storageKey: string;
          mimeType: string;
          size: number;
          fileName: string;
        };

        const result = await service.triggerProcessing(
          {
            fileId,
            versionId: body.versionId || fileId,
            storageKey: body.storageKey,
            mimeType: body.mimeType,
            size: body.size,
            fileName: body.fileName,
            tenantId: ctx.tenantId,
          },
          ctx
        );

        return jsonResponse(
          {
            processing: {
              started: true,
              enqueued: result.enqueued,
              jobId: result.jobId,
            },
          },
          requestId
        );
      } catch (error) {
        if (error instanceof errors.FileFnError) {
          return errorResponse(error, requestId);
        }
        throw error;
      }
    },
  };
}

export type ProcessingRoutes = ReturnType<typeof createProcessingRoutes>;
