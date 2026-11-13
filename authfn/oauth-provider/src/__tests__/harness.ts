import { createHash } from 'node:crypto';
import { authfn, type AuthFnRuntimeConfig } from 'authfn';
import { createUser } from 'authfn/core/users';
import { issueSession } from 'authfn/core/sessions';
import { memoryAdapter } from '../../../../packages/db/src/adapters/memory/index.js';
import {
  authFnOAuthProviderPlugin,
  type OAuthConsentInput,
  type OAuthLoginRequiredInput,
  type OAuthProviderClient,
  type OAuthProviderResource
} from '../index.js';

export const ORIGIN = 'https://auth.example.com';
export const REGISTRY = { memotron: ['read', 'write'], pointron: ['read', 'write'] } as const;
export const MEMOTRON = 'https://memotron.example.com/mcp';
export const POINTRON = 'https://pointron.example.com/mcp';
export const MEMOTRON_SECRET = 'memotron-introspection-secret';
export const POINTRON_SECRET = 'pointron-introspection-secret';

// RFC 7636 Appendix B.
export const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

// RFC 6749 4.1.1 and 2.3.1: client s6BhdRkqt3, secret gX1fBat3bV
// (Authorization: Basic czZCaGRSa3F0MzpnWDFmQmF0M2JW), redirect
// https://client.example.com/cb, state xyz.
export const RFC6749_CLIENT: OAuthProviderClient = {
  clientId: 's6BhdRkqt3',
  name: 'Example Client',
  clientSecret: 'gX1fBat3bV',
  redirectUris: ['https://client.example.com/cb']
};
export const RFC6749_BASIC = 'Basic czZCaGRSa3F0MzpnWDFmQmF0M2JW';

/** A public MCP host with a loopback redirect. */
export const MCP_HOST: OAuthProviderClient = {
  clientId: 'mcp-host',
  name: 'MCP Host',
  redirectUris: ['http://127.0.0.1/callback']
};

/** A pre-registered first-party client. */
export const RHOMBUS: OAuthProviderClient = {
  clientId: 'rhombus',
  name: 'Rhombus',
  trusted: true,
  redirectUris: ['https://rhombus.example.com/oauth/callback']
};

export const RESOURCES: OAuthProviderResource[] = [
  { resource: MEMOTRON, scopes: ['memotron:read', 'memotron:write'], introspectionSecret: MEMOTRON_SECRET },
  { resource: POINTRON, scopes: ['pointron:read', 'pointron:write'], introspectionSecret: POINTRON_SECRET }
];

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createProviderApp() {
  return authfn({ scopes: REGISTRY, plugins: [authFnOAuthProviderPlugin()] });
}

/**
 * Pauses the next insert into `model` after `arm()` until `release()`, to
 * force an interleaving with another operation; `arm()` resolves once the
 * insert is paused.
 */
export function createInsertPause(database: AuthFnRuntimeConfig['database'], model: string) {
  let paused: { reached: () => void; released: Promise<void> } | undefined;
  let release: () => void = () => {};
  const wrapped: AuthFnRuntimeConfig['database'] = {
    ...database,
    create: async (params) => {
      const pause = params.model === model ? paused : undefined;
      if (pause) {
        paused = undefined;
        pause.reached();
        await pause.released;
      }
      return database.create(params);
    }
  };
  return {
    database: wrapped,
    arm: () => new Promise<void>((reached) => {
      paused = { reached, released: new Promise<void>((resolve) => { release = resolve; }) };
    }),
    release: () => release()
  };
}

export async function setupProvider(options: { pauseInsertsInto?: string } = {}) {
  const database = memoryAdapter({ debug: false });
  const pause = createInsertPause(database, options.pauseInsertsInto ?? '');
  let now = new Date('2026-11-14T00:00:00.000Z');
  const consents: OAuthConsentInput[] = [];
  const logins: OAuthLoginRequiredInput[] = [];
  const server = createProviderApp().createServer({
    database: pause.database,
    pluginRuntime: {
      oauthProvider: {
        clients: [RFC6749_CLIENT, MCP_HOST, RHOMBUS],
        resources: RESOURCES,
        now: () => now,
        loginRequired: (input) => {
          logins.push(input);
          return new Response('sign in', { status: 401 });
        },
        consent: (input) => {
          consents.push(input);
          return new Response('consent page', { status: 200 });
        }
      }
    }
  });

  const coreConfig: AuthFnRuntimeConfig = { database, namespace: 'authfn', plugins: [], scopes: REGISTRY };
  const user = await createUser(coreConfig, { primaryEmail: 'user@example.com' });
  const session = await issueSession(coreConfig, {}, { userId: user.id, methods: ['password'] });
  const names = await server.cookieNamesForRequest(new Request(`${ORIGIN}/auth/session`));
  const cookie = `${names.sessionCookieName}=${session.sessionToken}; ${names.csrfCookieName}=${session.csrfToken}`;

  const handle = (path: string, init?: RequestInit) => server.router.handle(new Request(`${ORIGIN}${path}`, init));

  const authorizeQuery = (overrides: Record<string, string | undefined> = {}, client = RFC6749_CLIENT) => {
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0],
      state: 'xyz',
      code_challenge: RFC7636_CHALLENGE,
      code_challenge_method: 'S256',
      resource: MEMOTRON,
      ...overrides
    };
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        query.set(name, value);
      }
    }
    return query;
  };

  const getAuthorize = (query: URLSearchParams, signedIn = true) =>
    handle(`/auth/oauth/authorize?${query}`, { headers: signedIn ? { cookie } : {} });

  const decide = (params: Record<string, string>, decision: 'approve' | 'deny', csrf = session.csrfToken) =>
    handle('/auth/oauth/authorize', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-authfn-csrf': csrf },
      body: JSON.stringify({ ...params, decision })
    });

  /** Runs the browser half: authorization request, consent if asked, approval. */
  const authorize = async (
    overrides: Record<string, string | undefined> = {},
    client = RFC6749_CLIENT
  ): Promise<URL> => {
    const response = await getAuthorize(authorizeQuery(overrides, client));
    if (response.status === 302) {
      return new URL(response.headers.get('location')!);
    }
    if (response.status !== 200) {
      throw new Error(`authorization request failed with ${response.status}: ${await response.text()}`);
    }
    const consent = consents[consents.length - 1];
    const decided = await decide({ ...consent.params }, 'approve');
    const body = await decided.json() as { data: { redirectTo: string } };
    return new URL(body.data.redirectTo);
  };

  const token = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    handle('/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form)
    });

  /** Exchanges a code as the RFC 6749 confidential client, with the RFC 7636 verifier. */
  const exchange = (code: string, extra: Record<string, string> = {}, headers = { authorization: RFC6749_BASIC }) =>
    token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: RFC6749_CLIENT.redirectUris[0],
      code_verifier: RFC7636_VERIFIER,
      ...extra
    }, headers);

  const refresh = (refreshToken: string, extra: Record<string, string> = {}) =>
    token({ grant_type: 'refresh_token', refresh_token: refreshToken, ...extra }, { authorization: RFC6749_BASIC });

  const introspect = async (accessToken: string, secret = MEMOTRON_SECRET) => {
    const response = await handle('/auth/oauth/introspect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${secret}` },
      body: new URLSearchParams({ token: accessToken })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  const revoke = (tokenValue: string) =>
    handle('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: RFC6749_BASIC },
      body: new URLSearchParams({ token: tokenValue })
    });

  /** Authorizes and exchanges, returning the RFC 6749 5.1 token response. */
  const obtainTokens = async (overrides: Record<string, string | undefined> = {}) => {
    const callback = await authorize(overrides);
    const response = await exchange(callback.searchParams.get('code')!);
    if (response.status !== 200) {
      throw new Error(`token exchange failed with ${response.status}: ${await response.text()}`);
    }
    return await response.json() as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  };

  return {
    server,
    database,
    pause,
    coreConfig,
    user,
    session,
    cookie,
    consents,
    logins,
    handle,
    authorizeQuery,
    getAuthorize,
    decide,
    authorize,
    token,
    exchange,
    refresh,
    introspect,
    revoke,
    obtainTokens,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
    now: () => now
  };
}
