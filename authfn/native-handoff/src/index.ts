import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NotFoundError } from '@superfunctions/db';
import type { Route } from '@superfunctions/http';
import type {
  NativeHandoffPluginConfig,
  NativeHandoffPluginRuntimeConfig
} from 'authfn/plugin-types';
import type {
  AuthFnNativeHandoffCodeRecord,
  AuthFnPlugin,
  AuthFnPluginRuntimeContext,
  AuthFnSchemaDefinition,
  AuthFnSession,
  AuthFnSessionRecord
} from 'authfn';
import { resolveCookiePolicy } from 'authfn/core/cookies';
import {
  assertValidCsrf,
  authenticateSessionToken,
  hashSecret,
  issueSession,
  requireCookieSession
} from 'authfn/core/sessions';
import {
  AuthFnConflictError,
  AuthFnRegionMismatchError,
  AuthFnSessionRevokedError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError
} from 'authfn/core/errors';
import { emitAuthEvent, eventRequestId } from 'authfn/core/observability';
import { resolveEnvironment } from 'authfn/core/environment';
import { findUserById } from 'authfn/core/users';
import { issueSessionCookies } from 'authfn/core/cookies';
import { createAuthFnRouteMeta, readOptionalJson } from 'authfn/http/router';
import { jsonSuccess } from 'authfn/http/envelopes';
import { readPluginRuntimeConfig } from 'authfn/core/plugin-runtime';

export type {
  NativeHandoffPluginConfig,
  NativeHandoffPluginRuntimeConfig
} from 'authfn/plugin-types';

const DEFAULT_CODE_TTL_SECONDS = 60;
type ResolvedNativeHandoffPluginConfig = NativeHandoffPluginConfig & NativeHandoffPluginRuntimeConfig;

export function authFnNativeHandoffPlugin(
  config: NativeHandoffPluginConfig = {}
): AuthFnPlugin<'nativeHandoff', NativeHandoffPluginRuntimeConfig, false> {
  return {
    name: 'nativeHandoff',
    schema: () => config.schema ?? createNativeHandoffSchema(),
    routes: (ctx) => createNativeHandoffRoutes(ctx, config)
  };
}

function createNativeHandoffSchema(): AuthFnSchemaDefinition['schemas'] {
  return [
    {
      modelName: 'native_handoff_codes',
      fields: {
        id: { type: 'string', required: true, fieldName: 'id', maxLength: 255 },
        codeHash: { type: 'string', required: true, fieldName: 'code_hash', maxLength: 255 },
        sourceSessionId: { type: 'string', required: true, fieldName: 'source_session_id', maxLength: 255 },
        target: { type: 'string', required: true, fieldName: 'target' },
        regionId: { type: 'string', required: true, fieldName: 'region_id' },
        userId: { type: 'string', required: true, fieldName: 'user_id' },
        expiresAt: { type: 'date', required: true, fieldName: 'expires_at' },
        consumedAt: { type: 'date', required: false, fieldName: 'consumed_at' },
        createdAt: { type: 'date', required: true, fieldName: 'created_at' },
        metadata: { type: 'json', required: false, fieldName: 'metadata' }
      },
      indexes: [
        {
          name: 'idx_authfn_native_handoff_code_hash',
          fields: ['codeHash'],
          unique: true
        },
        {
          name: 'idx_authfn_native_handoff_source_session_id',
          fields: ['sourceSessionId']
        },
        {
          name: 'idx_authfn_native_handoff_expires_at',
          fields: ['expiresAt']
        }
      ]
    }
  ];
}

function createNativeHandoffRoutes(
  ctx: AuthFnPluginRuntimeContext,
  pluginConfig: NativeHandoffPluginConfig
): Route[] {
  const config: ResolvedNativeHandoffPluginConfig = {
    codeTtlSeconds: pluginConfig.codeTtlSeconds,
    webHandoff: pluginConfig.webHandoff,
    ...readPluginRuntimeConfig<NativeHandoffPluginRuntimeConfig>(ctx, 'nativeHandoff')
  };

  const routes: Route[] = [
    {
      method: 'POST',
      path: '/handoff/native/start',
      meta: createAuthFnRouteMeta('startNativeHandoff', 'Create a one-time native handoff code', {
        mode: 'cookie-session',
        csrf: true
      }),
      handler: async (request) => {
        const source = await requireNativeHandoffSource(ctx, request);
        const code = await createHandoffCode(ctx, config, {
          request,
          sourceSessionId: source.sessionId,
          userId: source.userId,
          regionId: source.regionId,
          target: 'native',
          metadata: {
            source: source.source
          }
        });

        return jsonSuccess(request, {
          code: code.code,
          regionId: code.record.regionId,
          expiresAt: code.record.expiresAt.toISOString()
        });
      }
    },
    {
      method: 'POST',
      path: '/handoff/native/exchange',
      meta: createAuthFnRouteMeta('exchangeNativeHandoff', 'Exchange a native handoff code for a bearer session', {
        mode: 'none'
      }),
      handler: async (request) => {
        const body = await readOptionalJson<{
          code?: string;
          device?: Record<string, unknown>;
        }>(request);
        const consumed = await consumeHandoffCode(ctx, request, body.code, 'native');
        const sourceSession = await findSessionRecord(ctx, consumed.record.sourceSessionId);
        const issued = await issueSession(ctx.config, ctx.hooks, {
          request,
          userId: consumed.record.userId,
          primaryEmail: consumed.user.primaryEmail,
          regionId: consumed.record.regionId,
          methods: sourceSession.methods,
          metadata: {
            sourceSessionId: consumed.record.sourceSessionId,
            handoffTarget: 'native',
            device: body.device
          }
        });

        await emitAuthEvent(ctx.config, {
          type: 'authfn.handoff.exchanged',
          requestId: eventRequestId(request),
          actorId: consumed.record.userId,
          userId: consumed.record.userId,
          sessionId: issued.session.id,
          regionId: consumed.record.regionId,
          outcome: 'native-exchanged'
        });

        return jsonSuccess(request, {
          session: issued.session,
          token: issued.sessionToken
        });
      }
    },
    {
      method: 'POST',
      path: '/handoff/web/start',
      meta: createAuthFnRouteMeta('startWebHandoff', 'Create a one-time WebView handoff code', {
        mode: 'bearer'
      }),
      handler: async (request) => {
        const session = await requireBearerSession(ctx, request);
        const body = await readOptionalJson<{
          returnTo?: string;
          verifierChallenge?: string;
        }>(request);
        const verifierChallenge = readVerifierChallenge(body.verifierChallenge);
        const code = await createHandoffCode(ctx, config, {
          request,
          sourceSessionId: session.record.id,
          userId: session.record.userId,
          regionId: session.session.regionId ?? (await resolveEnvironment(ctx.config, request)).regionId,
          target: 'web',
          metadata: {
            source: 'native',
            returnTo: sanitizeReturnTo(body.returnTo),
            ...(verifierChallenge ? { verifierChallenge } : {})
          }
        });

        const url = new URL(request.url);
        url.pathname = `${ctx.basePath.replace(/\/$/, '')}/handoff/web/consume`;
        url.search = '';
        url.searchParams.set('code', code.code);

        return jsonSuccess(request, {
          consumeUrl: url.toString(),
          code: code.code,
          expiresAt: code.record.expiresAt.toISOString()
        });
      }
    },
    {
      method: 'GET',
      path: '/handoff/web/consume',
      meta: createAuthFnRouteMeta('consumeWebHandoff', 'Consume a WebView handoff code and set session cookies', {
        mode: 'none'
      }),
      handler: async (request) => {
        const code = new URL(request.url).searchParams.get('code');
        await assertDirectWebConsumeNavigation(ctx, request);
        const consumed = await consumeHandoffCode(ctx, request, code, 'web', async (record) => {
          const challenge = record.metadata?.verifierChallenge;
          if (typeof challenge !== 'string') {
            return;
          }
          const verifier = request.headers.get(WEB_HANDOFF_VERIFIER_HEADER)?.trim() ?? '';
          if (!verifierMatches(verifier, challenge)) {
            await emitHandoffFailure(ctx, request, 'web', 'verifier-mismatch', record);
            throw new AuthFnValidationError('Handoff verifier is missing or does not match');
          }
        });
        const sourceSession = await findSessionRecord(ctx, consumed.record.sourceSessionId);
        const issued = await issueSession(ctx.config, ctx.hooks, {
          request,
          userId: consumed.record.userId,
          primaryEmail: consumed.user.primaryEmail,
          regionId: consumed.record.regionId,
          methods: sourceSession.methods,
          metadata: {
            sourceSessionId: consumed.record.sourceSessionId,
            handoffTarget: 'web'
          }
        });
        const runtime = issued.runtime ?? await resolveEnvironment(ctx.config, request);
        const cookiePolicy = issued.cookiePolicy ?? resolveCookiePolicy(ctx.config, request, runtime);
        const cookies = issueSessionCookies(cookiePolicy, issued.sessionToken, issued.csrfToken);
        const headers = new Headers({
          location: sanitizeReturnTo(consumed.record.metadata?.returnTo)
        });
        headers.append('set-cookie', cookies.sessionCookie);
        headers.append('set-cookie', cookies.csrfCookie);

        await emitAuthEvent(ctx.config, {
          type: 'authfn.handoff.exchanged',
          requestId: eventRequestId(request),
          actorId: consumed.record.userId,
          userId: consumed.record.userId,
          sessionId: issued.session.id,
          regionId: consumed.record.regionId,
          outcome: 'web-consumed'
        });

        return new Response(null, {
          status: 302,
          headers
        });
      }
    }
  ];
  return config.webHandoff === false
    ? routes.filter((route) => !route.path.startsWith('/handoff/web/'))
    : routes;
}

const WEB_HANDOFF_VERIFIER_HEADER = 'x-authfn-handoff-verifier';
const VERIFIER_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function readVerifierChallenge(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !VERIFIER_CHALLENGE_PATTERN.test(value)) {
    throw new AuthFnValidationError('verifierChallenge must be a base64url SHA-256 digest', {
      field: 'verifierChallenge'
    });
  }
  return value;
}

function verifierMatches(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) {
    return false;
  }
  const digest = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return digest.length === expected.length && timingSafeEqual(digest, expected);
}

async function createHandoffCode(
  ctx: AuthFnPluginRuntimeContext,
  pluginConfig: ResolvedNativeHandoffPluginConfig,
  input: {
    request: Request;
    sourceSessionId: string;
    userId: string;
    regionId?: string;
    target: 'native' | 'web';
    metadata?: Record<string, unknown>;
  }
): Promise<{ code: string; record: AuthFnNativeHandoffCodeRecord }> {
  if (!input.regionId) {
    throw new AuthFnValidationError('A region id is required to create a handoff code');
  }

  const now = pluginConfig.now?.() ?? new Date();
  const code = createOpaqueCode();
  const record: AuthFnNativeHandoffCodeRecord = {
    id: createIdentifier('handoff'),
    codeHash: hashSecret(code),
    sourceSessionId: input.sourceSessionId,
    target: input.target,
    regionId: input.regionId,
    userId: input.userId,
    expiresAt: new Date(now.getTime() + ((pluginConfig.codeTtlSeconds ?? DEFAULT_CODE_TTL_SECONDS) * 1000)),
    consumedAt: null,
    createdAt: now,
    metadata: input.metadata
  };

  await ctx.config.database.create<AuthFnNativeHandoffCodeRecord>({
    model: 'native_handoff_codes',
    data: record,
    namespace: ctx.namespace
  });

  await emitAuthEvent(ctx.config, {
    type: 'authfn.handoff.started',
    requestId: eventRequestId(input.request),
    actorId: input.userId,
    userId: input.userId,
    sessionId: input.sourceSessionId,
    regionId: input.regionId,
    outcome: input.target
  });

  return {
    code,
    record
  };
}

async function requireNativeHandoffSource(
  ctx: AuthFnPluginRuntimeContext,
  request: Request
): Promise<{
  sessionId: string;
  userId: string;
  regionId: string | undefined;
  source: 'web' | 'web-bearer';
}> {
  if (readBearerToken(request)) {
    const bearer = await requireBearerSession(ctx, request);
    return {
      sessionId: bearer.record.id,
      userId: bearer.record.userId,
      regionId: bearer.session.regionId ?? (await resolveEnvironment(ctx.config, request)).regionId,
      source: 'web-bearer'
    };
  }

  const state = await requireCookieSession(ctx.config, request);
  assertValidCsrf(request, state);
  return {
    sessionId: state.session.id,
    userId: state.user.id,
    regionId: state.session.regionId ?? state.runtime.regionId,
    source: 'web'
  };
}

async function consumeHandoffCode(
  ctx: AuthFnPluginRuntimeContext,
  request: Request,
  code: string | null | undefined,
  target: 'native' | 'web',
  verify?: (record: AuthFnNativeHandoffCodeRecord) => Promise<void>
): Promise<{ record: AuthFnNativeHandoffCodeRecord; user: { id: string; primaryEmail?: string } }> {
  if (!code) {
    await emitHandoffFailure(ctx, request, target, 'missing-code');
    throw new AuthFnValidationError('A handoff code is required');
  }

  const record = await ctx.config.database.findOne<AuthFnNativeHandoffCodeRecord>({
    model: 'native_handoff_codes',
    where: [{ field: 'codeHash', operator: 'eq', value: hashSecret(code) }],
    namespace: ctx.namespace
  });
  if (!record || record.target !== target) {
    await emitHandoffFailure(ctx, request, target, 'invalid-code');
    throw new AuthFnValidationError('Handoff code is invalid');
  }

  const runtime = await resolveEnvironment(ctx.config, request);
  if (runtime.regionId && record.regionId !== runtime.regionId) {
    await emitHandoffFailure(ctx, request, target, 'wrong-region', record);
    throw new AuthFnRegionMismatchError('Handoff code belongs to a different region', {
      regionId: record.regionId
    });
  }

  if (record.consumedAt) {
    await emitHandoffFailure(ctx, request, target, 'replayed', record);
    throw new AuthFnConflictError('Handoff code has already been consumed', {
      handoffId: record.id
    });
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    await emitHandoffFailure(ctx, request, target, 'expired', record);
    throw new AuthFnValidationError('Handoff code has expired', {
      handoffId: record.id
    });
  }

  await verify?.(record);

  const sourceSession = await findSessionRecord(ctx, record.sourceSessionId);
  if (sourceSession.revokedAt) {
    await emitHandoffFailure(ctx, request, target, 'revoked-source', record);
    throw new AuthFnSessionRevokedError('Source session has been revoked');
  }

  const user = await findUserById(ctx.config, record.userId);
  if (!user) {
    await emitHandoffFailure(ctx, request, target, 'missing-user', record);
    throw new AuthFnUnauthenticatedError('Handoff user no longer exists');
  }

  const consumedAt = new Date();
  const consumedRecord = await consumeHandoffRecordAtomically(ctx, request, target, record, consumedAt);

  return {
    record: consumedRecord,
    user
  };
}

async function consumeHandoffRecordAtomically(
  ctx: AuthFnPluginRuntimeContext,
  request: Request,
  target: 'native' | 'web',
  record: AuthFnNativeHandoffCodeRecord,
  consumedAt: Date
): Promise<AuthFnNativeHandoffCodeRecord> {
  try {
    return await ctx.config.database.update<AuthFnNativeHandoffCodeRecord>({
      model: 'native_handoff_codes',
      where: [
        { field: 'id', operator: 'eq', value: record.id },
        { field: 'consumedAt', operator: 'eq', value: null }
      ],
      data: {
        consumedAt
      },
      namespace: ctx.namespace
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      await emitHandoffFailure(ctx, request, target, 'replayed', record);
      throw new AuthFnConflictError('Handoff code has already been consumed', {
        handoffId: record.id
      });
    }
    throw error;
  }
}

async function requireBearerSession(
  ctx: AuthFnPluginRuntimeContext,
  request: Request
): Promise<{ session: AuthFnSession; record: AuthFnSessionRecord }> {
  const token = readBearerToken(request);
  if (!token) {
    throw new AuthFnUnauthenticatedError('Bearer session is required');
  }

  const session = await authenticateSessionToken(ctx.config, token, request);
  if (!session) {
    throw new AuthFnUnauthenticatedError('Bearer session is invalid');
  }

  return {
    session,
    record: await findSessionRecord(ctx, session.id)
  };
}

async function findSessionRecord(
  ctx: Pick<AuthFnPluginRuntimeContext, 'config' | 'namespace'>,
  sessionId: string
): Promise<AuthFnSessionRecord> {
  const record = await ctx.config.database.findOne<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: sessionId }],
    namespace: ctx.namespace
  });
  if (!record) {
    throw new AuthFnUnauthenticatedError('Source session was not found');
  }
  return record;
}

async function emitHandoffFailure(
  ctx: AuthFnPluginRuntimeContext,
  request: Request,
  target: 'native' | 'web',
  outcome: string,
  record?: AuthFnNativeHandoffCodeRecord
): Promise<void> {
  await emitAuthEvent(ctx.config, {
    type: 'authfn.handoff.failed',
    requestId: eventRequestId(request),
    actorId: record?.userId,
    userId: record?.userId,
    sessionId: record?.sourceSessionId,
    regionId: record?.regionId,
    outcome,
    metadata: {
      target
    }
  });
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof NotFoundError
    || Boolean(
      error
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'NotFoundError'
    );
}

const RETURN_TO_BASE = 'https://authfn-return-to.invalid';

/**
 * The web handoff consume URL is meant to be loaded directly by the native app
 * that minted the code. A browser marks such a load `Sec-Fetch-Site: none`; a
 * page on another site that redirects or links a visitor there is marked
 * `cross-site` or `same-site`. Refusing those stops a page from signing its
 * visitors into the page owner's account (login CSRF). A link opened from
 * outside the browser (mail, chat) is also `none`, so apps should mint codes
 * with `verifierChallenge` and send the verifier in the
 * `x-authfn-handoff-verifier` header when loading the consume URL.
 */
async function assertDirectWebConsumeNavigation(
  ctx: AuthFnPluginRuntimeContext,
  request: Request
): Promise<void> {
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (!fetchSite || fetchSite === 'none' || fetchSite === 'same-origin') {
    return;
  }
  await emitHandoffFailure(ctx, request, 'web', 'cross-site-navigation');
  throw new AuthFnValidationError('Handoff links must be opened directly by the app that created them', {
    fetchSite
  });
}

/**
 * Reduces a handoff return target to a same-origin path. The value is resolved
 * against a placeholder origin the way a browser resolves a `Location` header,
 * so backslashes, control characters and protocol-relative forms that a browser
 * would send to another host fall back to `/`.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '/';
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value)) {
    return '/';
  }
  try {
    const isPath = value.startsWith('/');
    const url = isPath ? new URL(value, RETURN_TO_BASE) : new URL(value);
    if (isPath && url.origin !== RETURN_TO_BASE) {
      return '/';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '/';
    }
    const relative = `${url.pathname}${url.search}${url.hash}` || '/';
    return relative.startsWith('/') && !relative.startsWith('//') ? relative : '/';
  } catch {
    return '/';
  }
}

function createOpaqueCode(): string {
  return `hf_${randomBytes(24).toString('base64url')}`;
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
