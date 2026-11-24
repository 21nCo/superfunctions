import type { FileArtifactRecord, ProcessingService } from './service.js';
import { artifactDurationOf, artifactSourceOf } from './client-artifacts.js';
import type { AuthConfig } from '../auth.js';
import type { RateLimiter } from '@superfunctions/middleware';
import { resolvePrincipal } from '../auth.js';
import * as errors from '../errors.js';
import { rateLimitSubject, type RateLimitCategory, type RateLimitClientKey } from '../rate-limit-key.js';
import { buildDownloadHeaders } from '../download-headers.js';
import { readJsonBody } from '../http-body.js';

export interface ProcessingRoutesConfig {
  service: ProcessingService;
  auth: AuthConfig;
  rateLimiter?: RateLimiter;
  rateLimits?: {
    artifactDownload?: {
      windowSeconds: number;
      maxRequests: number;
    };
    processing?: RateLimitCategory;
  };
  clientKey?: RateLimitClientKey;
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

/** The artifact fields FileFn's HTTP API returns. */
function artifactDescriptor(a: FileArtifactRecord) {
  const processingDurationMs = artifactDurationOf(a);
  return {
    artifactId: a.artifactId,
    fileId: a.fileId,
    versionId: a.versionId,
    kind: a.kind,
    mimeType: a.mimeType,
    size: a.size,
    source: artifactSourceOf(a),
    ...(processingDurationMs !== undefined ? { processingDurationMs } : {}),
    createdAt: a.createdAt,
  };
}

/** A non-negative integer query or header value, `undefined` when absent, NaN when malformed. */
function parseOptionalInteger(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
}

export function createProcessingRoutes(config: ProcessingRoutesConfig) {
  const { service, auth, rateLimiter, rateLimits, clientKey } = config;

  function requireAuth(principal: { principalId?: string; tenantId?: string } | null): void {
    if (!principal && auth.required !== false) {
      throw errors.authRequired();
    }
  }

  async function checkRateLimit(
    request: Request,
    category: string,
    principal: { principalId?: string; tenantId?: string } | null,
    categoryLimit?: RateLimitCategory,
  ): Promise<void> {
    if (!rateLimiter || !categoryLimit) {
      return;
    }

    const result = await rateLimiter.check({
      key: `${category}:${await rateLimitSubject(principal as { principalId: string; tenantId?: string } | null, request, clientKey)}`,
      windowSeconds: categoryLimit.windowSeconds,
      limit: categoryLimit.maxRequests,
    });
    if (!result.allowed) {
      throw errors.rateLimited(result.resetAt);
    }
  }

  const checkArtifactDownloadRateLimit = (request: Request, principal: { principalId?: string; tenantId?: string } | null) =>
    checkRateLimit(request, 'artifact-download', principal, rateLimits?.artifactDownload);

  return {
    async listArtifacts(request: Request, fileId: string): Promise<Response> {
      const requestId = getRequestId(request);

      try {
        const principal = await resolvePrincipal(request, auth);
        requireAuth(principal);
        await checkArtifactDownloadRateLimit(request, principal);
        const ctx = {
          // A guest reads as the principal 'anonymous', as on the file routes;
          // the service lets it read only public files.
          principalId: principal?.principalId ?? 'anonymous',
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        };

        const artifacts = await service.listArtifactsForFile(fileId, ctx);

        return jsonResponse({ artifacts: artifacts.map(artifactDescriptor) }, requestId);
      } catch (error) {
        if (error instanceof errors.FileFnError) {
          return errorResponse(error, requestId);
        }
        throw error;
      }
    },

    /**
     * `PUT /{fileId}/versions/{versionId}/artifacts/{kind}`: stores the body
     * as the client-supplied artifact of that kind. Repeating it replaces the
     * same artifact record.
     */
    async uploadArtifact(request: Request, fileId: string, versionId: string, kind: string): Promise<Response> {
      const requestId = getRequestId(request);

      try {
        const principal = await resolvePrincipal(request, auth);
        requireAuth(principal);
        const ctx = {
          // A write: a guest keeps no principal, so it can never match an owner.
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        };
        const url = new URL(request.url);
        const durationMs = parseOptionalInteger(url.searchParams.get('durationMs'));
        const contentLength = parseOptionalInteger(request.headers.get('content-length'));

        const artifact = await service.attachClientArtifact(
          {
            fileId,
            versionId,
            kind,
            mimeType: request.headers.get('content-type') ?? '',
            body: request.body,
            contentLength: Number.isNaN(contentLength) ? undefined : contentLength,
            durationMs,
          },
          ctx,
        );

        return jsonResponse({ artifact: artifactDescriptor(artifact) }, requestId);
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
        requireAuth(principal);
        await checkArtifactDownloadRateLimit(request, principal);
        const ctx = {
          // A guest reads as the principal 'anonymous', as on the file routes;
          // the service lets it read only public files.
          principalId: principal?.principalId ?? 'anonymous',
          tenantId: principal?.tenantId,
          roles: principal?.roles,
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
        requireAuth(principal);
        await checkArtifactDownloadRateLimit(request, principal);
        const ctx = {
          // A guest reads as the principal 'anonymous', as on the file routes;
          // the service lets it read only public files.
          principalId: principal?.principalId ?? 'anonymous',
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        };

        const result = await service.getArtifactDownloadStreamForFile(fileId, artifactId, ctx);

        return new Response(result.stream, {
          status: 200,
          headers: buildDownloadHeaders(result),
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
        requireAuth(principal);
        // Each run loads the source into memory and re-runs every processor.
        await checkRateLimit(request, 'processing', principal, rateLimits?.processing);

        // A guest reads as the principal 'anonymous', as on the file routes (the
        // service lets it read only public files); a forced (write) run keeps
        // no principal, so a guest never matches an owner.
        const ctx = {
          principalId: principal?.principalId ?? 'anonymous',
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        };
        const writeCtx = { ...ctx, principalId: principal?.principalId };

        const body = (await readJsonBody(request)) as {
          versionId?: string;
          force?: unknown;
        } | undefined;
        if (body?.force !== undefined && typeof body.force !== 'boolean') {
          throw errors.invalidRequest('force must be a boolean');
        }
        const force = body?.force === true;
        // Forcing replaces client-supplied artifacts, so it needs write access,
        // decided by the configured write check alone.
        const target = force
          ? await service.getWritableVersionForFile(fileId, writeCtx, body?.versionId)
          : await service.getReadableVersionForFile(fileId, ctx, body?.versionId);

        const result = await service.triggerProcessing(
          {
            fileId,
            versionId: target.version.versionId,
            storageKey: target.version.storageKey,
            mimeType: target.version.mimeType,
            size: target.version.size,
            fileName: target.file.name,
            tenantId: target.file.tenantId ?? ctx.tenantId,
            force,
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
