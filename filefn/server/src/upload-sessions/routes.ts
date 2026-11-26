import type { UploadSessionService } from './service.js';
import type { FileFnPrincipal, AuthConfig } from '../auth.js';
import type { RateLimiter } from '@superfunctions/middleware';
import { resolvePrincipal } from '../auth.js';
import { createHash } from 'crypto';
import { FileFnError, authRequired, invalidRequest, rateLimited, replayScopeMismatch } from '../errors.js';
import { rateLimitSubject, type RateLimitClientKey } from '../rate-limit-key.js';
import { readJsonBody } from '../http-body.js';
import { isAnonymousContext } from '../authz/ownership.js';

export interface RouteContext {
  service: UploadSessionService;
  auth: AuthConfig;
  rateLimiter?: RateLimiter;
  rateLimits?: {
    uploadInit?: {
      windowSeconds: number;
      maxRequests: number;
    };
    uploadSign?: {
      windowSeconds: number;
      maxRequests: number;
    };
    uploadComplete?: {
      windowSeconds: number;
      maxRequests: number;
    };
  };
  legacyGlobalRateLimit?: boolean;
  clientKey?: RateLimitClientKey;
}

/**
 * Marks an `upload/init` as an offline replay pinned to one account: its
 * value is the scope (`replayScopeOf`) of the owner and tenant the replay
 * must act for, from the generation's first init on. A marked init is
 * refused unless the caller is authenticated and not anonymous (401, also
 * where auth is optional, by the same test `createSession` uses for
 * idempotency: an anonymous replay would store the bytes outside the owner's
 * scope, with no idempotency) and unless the caller's scope is the pinned
 * one (409 FILEFN_REPLAY_SCOPE_MISMATCH). Either way nothing is created.
 * Unmarked requests, anonymous ones included, are unchanged.
 */
export const REPLAY_SCOPE_HEADER = 'x-filefn-replay-scope';

/**
 * An opaque fingerprint of the caller's owner and tenant (the scope its
 * idempotency keys live in), returned to a marked `upload/init` as
 * `replayScope`. It names no identifier.
 */
export function replayScopeOf(principal: Pick<FileFnPrincipal, 'principalId' | 'tenantId'>): string {
  const scope = JSON.stringify(['filefn-replay-scope', principal.principalId, principal.tenantId ?? null]);
  return `rs_${createHash('sha256').update(scope).digest('hex')}`;
}

function getRequestId(request: Request): string | undefined {
  return request.headers.get('x-request-id') || undefined;
}

function getIdempotencyKey(request: Request): string | undefined {
  return request.headers.get('x-idempotency-key') || undefined;
}

/** Warning returned when `upload/init` took its idempotency key from the JSON body. */
export const BODY_IDEMPOTENCY_KEY_DEPRECATED =
  'idempotencyKey in the upload/init body is deprecated and will be ignored after the next minor release; send the x-idempotency-key header';

/**
 * The idempotency key of an `upload/init` request. The `x-idempotency-key`
 * header is the contract. The JSON body's `idempotencyKey` (what
 * `@filefn/client` 0.4 and earlier sent) is still honored for one minor
 * version, with a deprecation warning. A request giving both must give the
 * same value.
 */
function resolveInitIdempotencyKey(
  request: Request,
  body: Record<string, unknown> | null | undefined,
): { idempotencyKey: unknown; fromBody: boolean } {
  const header = getIdempotencyKey(request);
  const bodyKey = body && typeof body === 'object' ? body.idempotencyKey : undefined;
  const hasBodyKey = bodyKey !== undefined && bodyKey !== null && bodyKey !== '';
  if (header !== undefined) {
    if (hasBodyKey && bodyKey !== header) {
      throw invalidRequest('x-idempotency-key and body idempotencyKey differ', { field: 'idempotencyKey' });
    }
    return { idempotencyKey: header, fromBody: false };
  }
  return hasBodyKey ? { idempotencyKey: bodyKey, fromBody: true } : { idempotencyKey: undefined, fromBody: false };
}

function getUploadSessionToken(request: Request): string | undefined {
  return request.headers.get('x-upload-session-token') || undefined;
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
  return await readJsonBody<T>(request);
}

export function createUploadSessionRoutes(ctx: RouteContext) {
  const { service, auth, rateLimiter, rateLimits, legacyGlobalRateLimit = false, clientKey } = ctx;

  async function resolveCaller(request: Request): Promise<FileFnPrincipal | null> {
    const principal = await resolvePrincipal(request, auth);
    if (!principal && auth.required !== false) {
      throw authRequired();
    }
    return principal;
  }

  async function checkRateLimit(
    request: Request,
    categoryKey: string,
    principal: FileFnPrincipal | null,
    categoryLimit?: { windowSeconds: number; maxRequests: number }
  ): Promise<void> {
    if (!rateLimiter) {
      return;
    }
    if (!categoryLimit && !legacyGlobalRateLimit) {
      return;
    }

    const result = await rateLimiter.check({
      key: `${categoryKey}:${await rateLimitSubject(principal, request, clientKey)}`,
      windowSeconds: categoryLimit?.windowSeconds,
      limit: categoryLimit?.maxRequests,
    });
    if (!result.allowed) {
      throw rateLimited(result.resetAt);
    }
  }

  return {
    async initSession(request: Request): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await resolveCaller(request);
        const pinnedScope = request.headers.get(REPLAY_SCOPE_HEADER);
        let replayScope: string | undefined;
        if (pinnedScope !== null) {
          if (!principal || isAnonymousContext(principal)) throw authRequired();
          replayScope = replayScopeOf(principal);
          if (pinnedScope !== replayScope) throw replayScopeMismatch();
        }
        await checkRateLimit(request, 'upload-init', principal, rateLimits?.uploadInit);

        const body = await parseJsonBody<{
          policy: string;
          fileName: string;
          size: number;
          mimeType: string;
          fileId?: string;
          metadata?: Record<string, unknown>;
          idempotencyKey?: unknown;
        }>(request);
        const { idempotencyKey, fromBody } = resolveInitIdempotencyKey(request, body);
        // A marked replay is only safe to repeat under its key: without one, a
        // repeat would create another session. Refused before any lookup, as
        // is a key given in either place that is empty or blank: one marked
        // init names exactly one usable key.
        const rawHeaderKey = request.headers.get('x-idempotency-key');
        const rawBodyKey = body && typeof body === 'object' ? body.idempotencyKey : undefined;
        const blank = (value: unknown) => typeof value !== 'string' || value.trim().length === 0;
        if (
          replayScope !== undefined &&
          (blank(idempotencyKey) ||
            (rawHeaderKey !== null && blank(rawHeaderKey)) ||
            (rawBodyKey !== undefined && rawBodyKey !== null && blank(rawBodyKey)))
        ) {
          throw invalidRequest('x-filefn-replay-scope requires an idempotency key (x-idempotency-key)', {
            field: 'idempotencyKey',
          });
        }

        const result = await service.createSession(
          // createSession validates the key (a string of bounded length).
          { ...body, idempotencyKey: idempotencyKey as string | undefined },
          { principalId: principal?.principalId, tenantId: principal?.tenantId, roles: principal?.roles, requestId }
        );
        const warnings = fromBody ? [...result.warnings, BODY_IDEMPOTENCY_KEY_DEPRECATED] : result.warnings;

        return successResponse({ ...result, warnings, ...(replayScope ? { replayScope } : {}) }, requestId, warnings);
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
        const principal = await resolveCaller(request);
        const result = await service.getSessionStatus(uploadSessionId, {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        }, getUploadSessionToken(request));
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
        const principal = await resolveCaller(request);
        await checkRateLimit(request, 'upload-sign', principal, rateLimits?.uploadSign);

        const body = await parseJsonBody<{ contentLength: number; checksumSha256Base64?: string }>(request);
        const result = await service.signPart(uploadSessionId, partNumber, body.contentLength, {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        }, getUploadSessionToken(request));
        return successResponse(result, requestId);
      } catch (err) {
        if (err instanceof FileFnError) {
          return errorResponse(err, requestId);
        }
        throw err;
      }
    },

    async uploadPartBytes(request: Request, uploadSessionId: string, partNumber: number): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const principal = await resolveCaller(request);
        await checkRateLimit(request, 'upload-complete', principal, rateLimits?.uploadComplete);
        // Rate limit check for data plane might differ, but using sign limit for now or skipping
        // await checkRateLimit(`upload-part:${principal.principalId}`, requestId);

        const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
        if (!request.body) {
          throw new FileFnError('FILEFN_INVALID_REQUEST', 'Missing request body', 400);
        }

        const result = await service.uploadPartBytes(uploadSessionId, partNumber, request.body, contentLength, {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        }, getUploadSessionToken(request));
        
        return successResponse({ ...result, recorded: true }, requestId);
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
        const principal = await resolveCaller(request);
        const body = await parseJsonBody<{ etag: string; size: number; checksumSha256Base64?: string }>(request);
        await checkRateLimit(request, 'upload-complete', principal, rateLimits?.uploadComplete);

        await service.completePart(uploadSessionId, partNumber, body.etag, body.size, {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        }, getUploadSessionToken(request));
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
        const principal = await resolveCaller(request);
        await checkRateLimit(request, 'upload-complete', principal, rateLimits?.uploadComplete);
        const result = await service.completeSession(uploadSessionId, {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        }, getUploadSessionToken(request));
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
        const principal = await resolveCaller(request);
        await service.abortSession(uploadSessionId, {
          principalId: principal?.principalId,
          tenantId: principal?.tenantId,
          roles: principal?.roles,
          requestId,
        }, getUploadSessionToken(request));
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
