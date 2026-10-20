import { createHash, randomUUID } from 'node:crypto';
import { assertValidAuthSession, type AuthProvider, type AuthSession } from '@superfunctions/auth';
import { wrapWithSchema, type Adapter } from '@superfunctions/db';
import { createRouter, PayloadTooLargeError, RouterError } from '@superfunctions/http';
import { corsMiddleware } from '@superfunctions/http/middleware';
import { getUserFnSchema } from './schema.js';
import { canonical, FeedbackConflictError, FeedbackValidationError, validateKey, validatePayload } from './validation.js';
export { getUserFnSchema } from './schema.js';

export interface UserFnServiceOptions {
  database: Adapter;
  /** Verifies bearer credentials. Cookie authentication is not accepted by this API. */
  auth: AuthProvider;
  /** Trusted server-side tenant/permission mapping after authentication; never use client claims. */
  resolveAccess?: (session: AuthSession) => Promise<{ tenantId: string; scopes: string[] } | null> | { tenantId: string; scopes: string[] } | null;
  maxBodyBytes?: number;
  /** Explicit browser origins; credentials/cookies are never enabled. */
  allowedOrigins?: string[];
}
interface StoredFeedback {
  id: string; tenantId: string; actorId: string; fingerprint: string;
  payload: Record<string, unknown>; createdAt: string; status: string; votes: number;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store',
} });

export function createUserFnService(options: UserFnServiceOptions) {
  if (!options.auth || typeof options.auth.authenticate !== 'function') throw new TypeError('UserFn requires an authentication provider');
  if (options.allowedOrigins?.some(origin => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; } catch { return true; }
  })) throw new TypeError('UserFn allowedOrigins must contain explicit HTTP(S) origins');
  const database = wrapWithSchema(options.database, getUserFnSchema());
  const authorize = async (request: Request, scope: string): Promise<AuthSession | Response> => {
    // Require explicit bearer credentials and exclude ambient cookies to avoid a cookie/CSRF fallback.
    if (!/^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) return json({ error: 'Unauthorized' }, 401);
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    let session: AuthSession | null;
    try {
      session = await options.auth.authenticate(new Request(request.url, { method: request.method, headers }));
    } catch (error) {
      // AuthFn uses status; shared auth errors use statusCode. Do not expose provider messages.
      if (error && typeof error === 'object' && (('status' in error && error.status === 401) || ('statusCode' in error && error.statusCode === 401))) return json({ error: 'Unauthorized' }, 401);
      throw error;
    }
    if (!session) return json({ error: 'Unauthorized' }, 401);
    try { assertValidAuthSession(session); } catch { return json({ error: 'Unauthorized' }, 401); }
    if (session.expiresAt && (!Number.isFinite(session.expiresAt.getTime()) || session.expiresAt.getTime() <= Date.now())) return json({ error: 'Unauthorized' }, 401);
    if (options.resolveAccess) {
      const access = await options.resolveAccess(session);
      if (!access || typeof access.tenantId !== 'string' || !Array.isArray(access.scopes) || access.scopes.some(scope => typeof scope !== 'string')) return json({ error: 'Forbidden' }, 403);
      session = { ...session, subject: { ...session.subject, tenantId: access.tenantId }, scopes: access.scopes };
    }
    const tenant = session.subject.tenantId;
    if (!tenant?.trim() || tenant.length > 200 || session.subject.actorId.length > 200 || !session.scopes?.includes(scope)) return json({ error: 'Forbidden' }, 403);
    return session;
  };
  const find = (tenantId: string, id: string) => database.findOne<StoredFeedback>({ model: 'userfn_feedback', where: [
    { field: 'tenantId', operator: 'eq', value: tenantId }, { field: 'id', operator: 'eq', value: id },
  ] });
  const errorResponse = (error: unknown): Response => {
      if (error instanceof PayloadTooLargeError) return json({ error: 'Payload too large' }, 413);
      if (error instanceof FeedbackConflictError) return json({ error: 'Idempotency key already used for different feedback' }, 409);
      if (error instanceof FeedbackValidationError || error instanceof SyntaxError) return json({ error: 'Invalid feedback request' }, 400);
      if (error instanceof RouterError && error.statusCode < 500) {
        const response = error.toResponse();
        response.headers.set('cache-control', 'no-store');
        return response;
      }
      return json({ error: 'Feedback service unavailable' }, 503);
  };
  const router = createRouter({
    maxBodyBytes: options.maxBodyBytes ?? 65536,
    onError: errorResponse,
    middleware: [
      ...(options.allowedOrigins ? [corsMiddleware({ origin: options.allowedOrigins, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], credentials: false })] : []),
      async (_request, _context, next) => { try { return await next(); } catch (error) { return errorResponse(error); } },
    ],
    routes: [
      { method: 'OPTIONS', path: '/feedback', handler: () => new Response(null, { status: 204 }) },
      { method: 'OPTIONS', path: '/feedback/:id', handler: () => new Response(null, { status: 204 }) },
      { method: 'POST', path: '/feedback', handler: async (request, context) => {
        const session = await authorize(request, 'userfn:feedback:write');
        if (session instanceof Response) return session;
        const tenantId = session.subject.tenantId!;
        const actorId = session.subject.actorId;
        const key = validateKey(request.headers.get('idempotency-key') ?? randomUUID());
        const payload = validatePayload(await context.json());
        const id = 'uf_' + hash(JSON.stringify([tenantId, key]));
        const fingerprint = hash(canonical({ actorId, payload }));
        const duplicate = (row: StoredFeedback) => {
          if (row.fingerprint !== fingerprint) throw new FeedbackConflictError();
          return json({ id: row.id, accepted: true }, 200);
        };
        const existing = await find(tenantId, id);
        if (existing) return duplicate(existing);
        try {
          await database.create({ model: 'userfn_feedback', data: {
            id, tenantId, actorId, fingerprint, payload, createdAt: new Date().toISOString(), status: 'open', votes: 0,
          } });
        } catch (error) {
          // The primary key resolves concurrent retries atomically; never overwrite the winning payload.
          const winner = await find(tenantId, id);
          if (winner) return duplicate(winner);
          throw error;
        }
        return json({ id, accepted: true }, 201);
      } },
      { method: 'GET', path: '/feedback/:id', handler: async (request, context) => {
        const session = await authorize(request, 'userfn:feedback:read');
        if (session instanceof Response) return session;
        const row = await find(session.subject.tenantId!, context.params.id);
        if (!row) return json({ error: 'Feedback not found' }, 404);
        const { fingerprint: _fingerprint, ...feedback } = row;
        return json(feedback);
      } },
    ],
  });
  return { router };
}
