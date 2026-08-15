import {
  createAuthFn,
  type AuthFnConfig,
  type AuthFnSession,
} from '@authfn/core';
import type { AdminScope } from '@superfunctions/admin';
import type {
  SuperConsoleOperatorAuth,
  SuperConsolePrincipal,
  SuperConsoleSignInResult,
} from './types.js';

export interface AuthFnOperatorAuthOptions {
  config: AuthFnConfig;
  resolveOperator(input: {
    session: AuthFnSession;
    request: Request;
  }): Promise<SuperConsolePrincipal | null> | SuperConsolePrincipal | null;
  authorizeScope(input: {
    principal: SuperConsolePrincipal;
    requested: AdminScope;
    request: Request;
  }): Promise<AdminScope | null> | AdminScope | null;
}

interface AuthFnEnvelope {
  ok?: boolean;
  data?: { session?: AuthFnSession | null };
  error?: { code?: string; message?: string; retryable?: boolean };
  requestId?: string;
}

class SuperConsoleAuthFnResponseError extends Error {
  readonly authFnResponse: Response;
  readonly authFnCode?: string;
  readonly authFnStatus: number;

  constructor(response: Response, payload: AuthFnEnvelope) {
    super(payload.error?.message ?? 'AuthFn rejected the authentication request.');
    this.name = 'SuperConsoleAuthFnResponseError';
    this.authFnResponse = response;
    this.authFnCode = payload.error?.code;
    this.authFnStatus = response.status;
  }
}

function authRequest(original: Request, path: string, body?: unknown): Request {
  const url = new URL(original.url);
  url.pathname = path;
  url.search = '';
  const headers = new Headers(original.headers);
  headers.set('accept', 'application/json');
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(url, {
    method: body === undefined ? original.method : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function envelope(response: Response): Promise<AuthFnEnvelope> {
  return response.clone().json().catch(() => ({})) as Promise<AuthFnEnvelope>;
}

function throwAuthResponse(response: Response, payload: AuthFnEnvelope): never {
  throw new SuperConsoleAuthFnResponseError(response, payload);
}

function authResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const source = upstream.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of source.getSetCookie?.() ?? []) headers.append('set-cookie', cookie);
  if (!source.getSetCookie && source.has('set-cookie')) headers.append('set-cookie', source.get('set-cookie')!);
  for (const name of ['cache-control', 'retry-after', 'x-request-id']) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function withCookieNames(
  authFn: ReturnType<typeof createAuthFn>,
  principal: SuperConsolePrincipal,
  request: Request,
): Promise<SuperConsolePrincipal> {
  const names = await authFn.cookieNamesForRequest(request);
  return {
    ...principal,
    authentication: {
      ...principal.authentication,
      csrfCookieName: names.csrfCookieName,
    },
  };
}

async function resolveSuccessfulOperator(
  authFn: ReturnType<typeof createAuthFn>,
  options: AuthFnOperatorAuthOptions,
  upstream: Response,
  payload: AuthFnEnvelope,
  request: Request,
): Promise<SuperConsoleSignInResult> {
  if (!upstream.ok || payload.ok === false || !payload.data?.session) throwAuthResponse(upstream, payload);
  const principal = await options.resolveOperator({ session: payload.data.session, request });
  if (!principal) {
    await authFn.revokeSession(payload.data.session.id, { userId: payload.data.session.actorId });
    const denied = new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'SUPERCONSOLE_OPERATOR_FORBIDDEN',
        message: 'The authenticated identity is not an authorized Super Console operator.',
        status: 403,
      },
      requestId: payload.requestId,
    }), { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    throwAuthResponse(denied, await envelope(denied));
  }
  return {
    principal: await withCookieNames(authFn, principal, request),
    headers: authResponseHeaders(upstream),
  };
}

/**
 * Uses AuthFn's composed router for sign-in/sign-out, preserving plugins,
 * hooks, rate limits, 2FA challenge semantics, CSRF and cookie behavior.
 */
export function createAuthFnOperatorAuth(options: AuthFnOperatorAuthOptions): SuperConsoleOperatorAuth {
  const config = options.config;
  const authFn = createAuthFn(config);
  const basePath = (config.basePath ?? '/auth').replace(/\/+$/, '') || '/';
  const route = (suffix: string) => `${basePath === '/' ? '' : basePath}${suffix}`;

  return {
    async authenticate(request) {
      const session = await authFn.provider.authenticate(request);
      if (!session) return null;
      const principal = await options.resolveOperator({ session, request });
      return principal ? withCookieNames(authFn, principal, request) : null;
    },
    async authorizeScope(input) {
      return options.authorizeScope(input);
    },
    async authorizeMutation({ request }) {
      await authFn.authorizeMutation(request);
    },
    async signIn({ email, password, request }) {
      const upstream = await authFn.router.handle(authRequest(request, route('/sign-in/password'), {
        email,
        password,
        sessionMode: 'cookie',
      }));
      const payload = await envelope(upstream);
      // A 2FA-required response is non-success and contains no session/cookies;
      // preserve it as an AuthFn response instead of issuing a Console session.
      return resolveSuccessfulOperator(authFn, options, upstream, payload, request);
    },
    async completeTwoFactor({ challengeId, code, request }) {
      const upstream = await authFn.router.handle(authRequest(request, route('/2fa/challenge'), { challengeId, code }));
      const payload = await envelope(upstream);
      return resolveSuccessfulOperator(authFn, options, upstream, payload, request);
    },
    async signOut({ request }) {
      const upstream = await authFn.router.handle(authRequest(request, route('/sign-out'), {}));
      const payload = await envelope(upstream);
      if (!upstream.ok || payload.ok === false) throwAuthResponse(upstream, payload);
      return { headers: authResponseHeaders(upstream) };
    },
  };
}

export function isAuthFnResponseError(error: unknown): error is Error & { authFnResponse: Response } {
  return error instanceof SuperConsoleAuthFnResponseError;
}
