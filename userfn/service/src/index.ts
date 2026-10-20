import { createHash, randomUUID } from 'node:crypto';
import { assertValidAuthSession, type AuthProvider, type AuthSession } from '@superfunctions/auth';
import { wrapWithSchema, type Adapter, type WhereClause } from '@superfunctions/db';
import { createRouter, PayloadTooLargeError, RouterError } from '@superfunctions/http';
import { corsMiddleware } from '@superfunctions/http/middleware';
import { getUserFnSchema } from './schema.js';
import { canonical, FeedbackConflictError, FeedbackValidationError, validateKey, validatePayload, object } from './validation.js';
import { readFilterMarker, writeFeedbackFilters, normalizeFilter } from './feedback-filters.js';
export { backfillFeedbackFilters } from './feedback-filters.js';
export { getUserFnSchema } from './schema.js';

export interface UserFnServiceOptions {
  database: Adapter;
  /** Verifies bearer credentials. Cookie authentication is not accepted by this API. */
  auth: AuthProvider;
  /** Trusted server-side tenant/permission mapping after authentication; never use client claims. */
  resolveAccess?: (session: AuthSession) => Promise<{ tenantId: string; scopes: string[] } | null> | { tenantId: string; scopes: string[] } | null;
  maxBodyBytes?: number;
  /** Maximum vote rows read per item; overflow fails rather than reporting a partial score. Default 10,000. */
  maxVotesPerFeedback?: number;
  /** Maximum normalized matching candidates before pagination; default500, range1–500. */
  maxFilterCandidates?: number;
  /** Explicit browser origins; credentials/cookies are never enabled. */
  allowedOrigins?: string[];
}
interface StoredFeedback {
  id: string; tenantId: string; actorId: string; fingerprint: string;
  payload: Record<string, unknown>; createdAt: string; status: string; votes: number;
}
const statuses = ['open', 'planned', 'in_progress', 'done', 'closed'];
const validId = (id: string) => /^uf_[a-f0-9]{64}$/.test(id);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store',
} });

export function createUserFnService(options: UserFnServiceOptions) {
  if (!options.auth || typeof options.auth.authenticate !== 'function') throw new TypeError('UserFn requires an authentication provider');
  if (options.allowedOrigins?.some(origin => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; } catch { return true; }
  })) throw new TypeError('UserFn allowedOrigins must contain explicit HTTP(S) origins');
  const maxCandidates = options.maxFilterCandidates ?? 500;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500) throw new TypeError('maxFilterCandidates must be an integer from 1 to 500');
  const maxVotes = options.maxVotesPerFeedback ?? 10000;
  if (!Number.isInteger(maxVotes) || maxVotes < 1 || maxVotes > 100000) throw new TypeError('maxVotesPerFeedback must be an integer from 1 to 100000');
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
  const votes = async (tenantId: string, feedbackId: string, actorId: string, actorType: string) => {
    // One projection query supplies score and own vote from the same read, independent of transaction defaults.
    const rows = await database.findMany<{ direction: number; actorId: string; actorType: string }>({ model: 'userfn_feedback_votes',
      where: [{ field: 'tenantId', operator: 'eq', value: tenantId }, { field: 'feedbackId', operator: 'eq', value: feedbackId }],
      select: ['direction', 'actorId', 'actorType'], limit: maxVotes + 1 });
    if (rows.length > maxVotes) throw new Error('Feedback vote projection exceeds configured bound');
    return { votes: rows.reduce((sum, row) => sum + row.direction, 0), viewerVote: rows.find(row => row.actorId === actorId && row.actorType === actorType)?.direction ?? 0 };
  };
  const boardItem = async (row: StoredFeedback, actorId: string, actorType: string) => {
    const feedback = row.payload.feedback as Record<string, unknown>;
    return { id: row.id, title: feedback.title, body: feedback.body, category: feedback.category, productArea: typeof feedback.productArea === 'string' ? normalizeFilter(feedback.productArea, 100) : null, tags: [...new Set(((feedback.tags as string[] | undefined) ?? []).map(tag => normalizeFilter(tag, 64)))],
      status: row.status, createdAt: row.createdAt, ...await votes(row.tenantId, row.id, actorId, actorType) };
  };
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
      ...(options.allowedOrigins ? [corsMiddleware({ origin: options.allowedOrigins, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], credentials: false })] : []),
      async (_request, _context, next) => { try { return await next(); } catch (error) { return errorResponse(error); } },
    ],
    routes: [
      { method: 'OPTIONS', path: '/feedback', handler: () => new Response(null, { status: 204 }) },
      { method: 'OPTIONS', path: '/feedback/:id', handler: () => new Response(null, { status: 204 }) },
      { method: 'OPTIONS', path: '/feedback/:id/vote', handler: () => new Response(null, { status: 204 }) },
      { method: 'OPTIONS', path: '/feedback/:id/status', handler: () => new Response(null, { status: 204 }) },
      { method: 'GET', path: '/feedback', handler: async (request) => {
        const session = await authorize(request, 'userfn:feedback:read');
        if (session instanceof Response) return session;
        const query = new URL(request.url).searchParams;
        if ([...query.keys()].some(key => !['limit', 'after', 'status', 'tag', 'productArea'].includes(key) || query.getAll(key).length !== 1)) throw new FeedbackValidationError();
        const rawLimit = query.get('limit') ?? '20';
        const limit = Number(rawLimit);
        const after = query.get('after'); const status = query.get('status');
        if (!/^[0-9]+$/.test(rawLimit) || limit < 1 || limit > 100 || (after !== null && !validId(after)) || (status !== null && !statuses.includes(status))) throw new FeedbackValidationError();
        const where: WhereClause[] = [{ field: 'tenantId', operator: 'eq', value: session.subject.tenantId! }];
        if (after) where.push({ field: 'id', operator: 'gt', value: after });
        if (status) where.push({ field: 'status', operator: 'eq', value: status });
        const tag = query.get('tag'); const area = query.get('productArea');
        if (tag !== null || area !== null) {
          const normalizedTag = tag === null ? null : normalizeFilter(tag, 64);
          const normalizedArea = area === null ? null : normalizeFilter(area, 100);
          if ((await readFilterMarker(database))?.status !== 'ready') throw new Error('Feedback filter backfill is incomplete');
          const tenant = { field: 'tenantId', operator: 'eq' as const, value: session.subject.tenantId! };
          let ids: string[] | undefined;
          if (normalizedTag !== null) {
            const matches = await database.findMany<{ feedbackId: string }>({ model: 'userfn_feedback_tags', where: [tenant, { field: 'tag', operator: 'eq', value: normalizedTag }], select: ['feedbackId'], limit: maxCandidates + 1 });
            if (matches.length > maxCandidates) throw new Error('Feedback filter candidate limit exceeded');
            ids = matches.map(row => row.feedbackId);
          }
          if (normalizedArea !== null && (!ids || ids.length)) {
            const matches = await database.findMany<{ id: string }>({ model: 'userfn_feedback_attributes', where: [tenant, { field: 'productArea', operator: 'eq', value: normalizedArea }, ...(ids ? [{ field: 'id', operator: 'in' as const, value: ids }] : [])], select: ['id'], limit: maxCandidates + 1 });
            if (matches.length > maxCandidates) throw new Error('Feedback filter candidate limit exceeded');
            ids = matches.map(row => row.id);
          }
          if (!ids?.length) return json({ items: [], nextCursor: null });
          where.push({ field: 'id', operator: 'in', value: ids });
        }
        const rows = await database.findMany<StoredFeedback>({ model: 'userfn_feedback', where, limit: limit + 1, orderBy: [{ field: 'id', direction: 'asc' }] });
        const selected = rows.slice(0, limit);
        const items = [];
        for (const row of selected) items.push(await boardItem(row, session.subject.actorId, session.subject.actorType));
        return json({ items, nextCursor: rows.length > limit ? selected[selected.length - 1].id : null });
      } },
      { method: 'POST', path: '/feedback/:id/vote', handler: async (request, context) => {
        const session = await authorize(request, 'userfn:feedback:vote');
        if (session instanceof Response) return session;
        const body = await context.json();
        if (!validId(context.params.id) || !object(body) || Object.keys(body).some(key => key !== 'direction') || ![-1, 0, 1].includes(body.direction as number)) throw new FeedbackValidationError();
        const tenantId = session.subject.tenantId!; const actorId = session.subject.actorId;
        if (!await find(tenantId, context.params.id)) return json({ error: 'Feedback not found' }, 404);
        const id = 'uv_' + hash(JSON.stringify([tenantId, context.params.id, session.subject.actorType, actorId]));
        const where: WhereClause[] = [{ field: 'id', operator: 'eq', value: id }, { field: 'tenantId', operator: 'eq', value: tenantId }];
        if (body.direction === 0) await database.deleteMany({ model: 'userfn_feedback_votes', where });
        else await database.upsert({ model: 'userfn_feedback_votes', where, conflictTarget: 'id', create: { id, tenantId, feedbackId: context.params.id, actorId, actorType: session.subject.actorType, direction: body.direction }, update: { direction: body.direction } });
        return json({ id: context.params.id, ...await votes(tenantId, context.params.id, actorId, session.subject.actorType) });
      } },
      { method: 'PATCH', path: '/feedback/:id/status', handler: async (request, context) => {
        const session = await authorize(request, 'userfn:feedback:moderate');
        if (session instanceof Response) return session;
        const body = await context.json();
        if (!validId(context.params.id) || !object(body) || Object.keys(body).some(key => key !== 'status') || !statuses.includes(body.status as string)) throw new FeedbackValidationError();
        const tenantId = session.subject.tenantId!;
        if (!await find(tenantId, context.params.id)) return json({ error: 'Feedback not found' }, 404);
        await database.update({ model: 'userfn_feedback', where: [{ field: 'tenantId', operator: 'eq', value: tenantId }, { field: 'id', operator: 'eq', value: context.params.id }], data: { status: body.status } });
        return json({ id: context.params.id, status: body.status });
      } },
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
          if (!database.capabilities.transactions.supported) throw new Error('Feedback persistence requires transactions');
          await database.transaction(async tx => {
            if ((await readFilterMarker(tx))?.status === 'building') throw new Error('Feedback filter migration is running');
            await tx.create({ model: 'userfn_feedback', data: {
              id, tenantId, actorId, fingerprint, payload, createdAt: new Date().toISOString(), status: 'open', votes: 0,
            } });
            await writeFeedbackFilters(tx, { id, tenantId, payload });
          });
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
        return json({ ...feedback, ...await votes(row.tenantId, row.id, session.subject.actorId, session.subject.actorType) });
      } },
    ],
  });
  return { router };
}
