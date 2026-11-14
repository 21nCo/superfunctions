import { createHash } from 'node:crypto';
import { authfn, type AuthFnRuntimeConfig } from 'authfn';
import { createUser } from 'authfn/core/users';
import { issueSession } from 'authfn/core/sessions';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { wrapWithSchema } from '../../../../packages/db/src/adapter/schema-codecs.js';
import { kyselyAdapter } from '../../../../packages/db/src/adapters/kysely/index.js';
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

// RFC 6749 4.1.1 and 2.3.1: the example client s6BhdRkqt3 with its public
// example secret, redirect https://client.example.com/cb, state xyz. The
// Basic header is the RFC's example value, derived here.
export const RFC6749_CLIENT: OAuthProviderClient = {
  clientId: 's6BhdRkqt3',
  name: 'Example Client',
  clientSecret: 'gX1fBat3bV',
  redirectUris: ['https://client.example.com/cb']
};
export const RFC6749_BASIC = `Basic ${btoa(`${RFC6749_CLIENT.clientId}:${RFC6749_CLIENT.clientSecret}`)}`;

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

type Adapter = AuthFnRuntimeConfig['database'];

type Operation = 'create' | 'findOne' | 'updateMany' | 'updateManyRejected';

/**
 * Controls storage calls: `arm(model)` pauses the next insert into `model`
 * until `release()` and resolves once it is paused, to force an interleaving;
 * `failNext(model, match, operation)` makes the next matching insert or
 * `findOne` throw, the next `updateMany` commit and then throw, as when its
 * acknowledgement is lost, or (`updateManyRejected`) throw without applying.
 */
export function createInsertControl(database: Adapter) {
  let paused: { model: string; reached: () => void; released: Promise<void> } | undefined;
  const failures: { model: string; operation: Operation; match: (params: { data?: Record<string, unknown> }) => boolean }[] = [];
  let release: () => void = () => {};
  const injectFailure = (operation: Operation, params: { model: string; data?: Record<string, unknown> }) => {
    const index = failures.findIndex((failure) =>
      failure.operation === operation && failure.model === params.model && failure.match(params));
    if (index >= 0) {
      failures.splice(index, 1);
      throw new Error(`injected ${operation} failure`);
    }
  };
  const wrapped: Adapter = {
    ...database,
    findOne: async (params) => {
      injectFailure('findOne', params);
      return database.findOne(params);
    },
    updateMany: async (params) => {
      injectFailure('updateManyRejected', params);
      const updated = await database.updateMany(params);
      injectFailure('updateMany', params);
      return updated;
    },
    create: async (params) => {
      injectFailure('create', params);
      const pause = paused?.model === params.model ? paused : undefined;
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
    arm: (model: string) => new Promise<void>((reached) => {
      paused = { model, reached, released: new Promise<void>((resolve) => { release = resolve; }) };
    }),
    release: () => release(),
    failNext: (model: string, match: (params: { data?: Record<string, unknown> }) => boolean, operation: Operation = 'create') => {
      failures.push({ model, operation, match });
    }
  };
}

/**
 * The shipped Kysely adapter on an in-memory SQLite database, with one column
 * per schema field. SQLite has no JSON type, so JSON fields are stored as
 * text. The adapter's `create` and `update` fail on SQLite (`selectAll` on an
 * insert, `RETURNING "*"`), a packages/db defect outside this package
 * (AUTH-13), so inserts go through Kysely and `update` (used by AuthFn core
 * sessions) runs as `updateMany` and `findOne`. The OAuth store's claims,
 * generation reads and writes, other reads and deletes use the adapter itself.
 */
function sqliteAdapter(): Adapter {
  const sqlite = new Database(':memory:');
  for (const table of createProviderApp().getSchema().schemas) {
    sqlite.exec(`CREATE TABLE "${table.modelName}" (${Object.keys(table.fields).map((field) => `"${field}"`).join(', ')})`);
  }
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
  const kysely = kyselyAdapter({
    db,
    dialect: 'sqlite',
    schema: new Proxy({}, { get: (_, model) => model }) as Record<string, string>
  });
  const encode = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([name, value]) => [
    name,
    value instanceof Date ? value.toISOString() : value !== null && typeof value === 'object' ? JSON.stringify(value) : value
  ]));
  const decode = <T>(row: T): T => (row && Object.fromEntries(Object.entries(row).map(([name, value]) => [
    name,
    typeof value === 'string' && /^[[{]/.test(value) ? JSON.parse(value) : value
  ]))) as T;
  return {
    ...kysely,
    create: async (params) => {
      await db.insertInto(params.model).values(encode(params.data)).execute();
      return params.data;
    },
    findOne: async (params) => decode(await kysely.findOne(params)),
    findMany: async (params) => (await kysely.findMany(params)).map(decode),
    update: async (params) => {
      await kysely.updateMany({ ...params, data: encode(params.data) });
      return decode(await kysely.findOne(params));
    },
    updateMany: (params) => kysely.updateMany({ ...params, data: encode(params.data) })
  } as Adapter;
}

export async function setupProvider(options: { sql?: boolean; clients?: OAuthProviderClient[] } = {}) {
  const raw = options.sql ? sqliteAdapter() : memoryAdapter({ debug: false });
  // Tests read and write rows the way the server does: through the schema.
  const database = options.sql ? wrapWithSchema(raw, createProviderApp().getSchema()) : raw;
  const control = createInsertControl(raw);
  let now = new Date('2026-11-14T00:00:00.000Z');
  const consents: OAuthConsentInput[] = [];
  const logins: OAuthLoginRequiredInput[] = [];
  const server = createProviderApp().createServer({
    database: control.database,
    pluginRuntime: {
      oauthProvider: {
        clients: [RFC6749_CLIENT, MCP_HOST, RHOMBUS, ...(options.clients ?? [])],
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
    control,
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
