/**
 * Storage conformance suite for authfn on SQLite through `@superfunctions/db`.
 *
 * The same cases run on better-sqlite3 under Node and on Cloudflare D1 under
 * workerd. Each case applies the Drizzle Kit migration generated from the
 * published `generate-schema --dialect sqlite` output, wires authfn exactly as
 * the self-hosting guide does, and inspects the tables through the raw driver.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnPasswordPlugin } from '@authfn/password';
import { drizzleAdapter } from '../../../../../packages/db/src/adapters/drizzle/index.js';
import { authfn, authFnPlugins, type AuthFnServer } from '../../index.js';
import { migrationStatements } from './fixture.js';

export interface SqliteHarness {
  /** Drizzle database created with `{ schema }` from the generated authfn schema. */
  db: unknown;
  /** Runs SQL statements in order, one statement per entry. */
  exec(statements: string[]): Promise<void>;
  /** Reads rows straight from the driver, bypassing authfn and Drizzle. */
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void> | void;
}

type Json = Record<string, any>;

interface CallOptions {
  body?: unknown;
  cookies?: string;
  csrf?: string;
  bearer?: string;
}

interface CallResult {
  status: number;
  body: Json;
  setCookies: string[];
}

interface SignedIn {
  cookies: string;
  csrf: string;
  userId: string;
  sessionId: string;
}

const ORIGIN = 'https://auth.example.com';
const PASSWORD = 'correct horse battery staple';

export function describeAuthFnSqliteConformance(
  driver: string,
  createHarness: () => Promise<SqliteHarness>
): void {
  // Each sign-up and sign-in runs scrypt, so allow for slow shared CI runners.
  describe(`authfn + drizzleAdapter({ dialect: 'sqlite' }) on ${driver}`, { timeout: 30_000 }, () => {
    let harness: SqliteHarness;
    let auth: AuthFnServer;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.exec(migrationStatements);
      // Wired the way docs/recipes/self-hosting-sqlite-d1 shows.
      const authApp = authfn({
        plugins: authFnPlugins(authFnPasswordPlugin(), authFnApiKeyPlugin())
      });
      auth = authApp.createServer({
        database: drizzleAdapter({ db: harness.db, dialect: 'sqlite' })
      });
    });

    afterEach(async () => {
      await harness.close();
    });

    async function call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
      const headers = new Headers();
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      if (options.cookies) headers.set('cookie', options.cookies);
      if (options.csrf) headers.set('x-authfn-csrf', options.csrf);
      if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
      const response = await auth.router.handle(
        new Request(`${ORIGIN}/auth${path}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body)
        })
      );
      return {
        status: response.status,
        body: (await response.json()) as Json,
        setCookies: response.headers.getSetCookie()
      };
    }

    async function row(table: string, id: string): Promise<Record<string, unknown>> {
      const rows = await harness.all(`SELECT * FROM "${table}" WHERE "id" = ?`, id);
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    async function signUp(email: string): Promise<SignedIn> {
      const response = await call('POST', '/sign-up/password', {
        body: { email, password: PASSWORD }
      });
      expect(response.status).toBe(200);
      return readSignedIn(response);
    }

    it('applies the generated migration with the unique indexes authfn relies on', async () => {
      const tables = await harness.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'authfn_%' ORDER BY name"
      );
      expect(tables.map((table) => table.name)).toEqual([
        'authfn_api_keys',
        'authfn_password_credentials',
        'authfn_sessions',
        'authfn_users'
      ]);

      const uniqueIndexes = await harness.all(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%' ORDER BY name"
      );
      expect(uniqueIndexes).toEqual([
        { name: 'idx_authfn_api_keys_secret_hash', tbl_name: 'authfn_api_keys' },
        { name: 'idx_authfn_password_credentials_user_id', tbl_name: 'authfn_password_credentials' },
        { name: 'idx_authfn_sessions_token_hash', tbl_name: 'authfn_sessions' },
        { name: 'idx_authfn_users_primary_email', tbl_name: 'authfn_users' }
      ]);
    });

    it('creates a user with a password and stores timestamps as epoch milliseconds', async () => {
      const before = Date.now();
      const signedIn = await signUp('Owner@Example.com');
      const after = Date.now();

      const user = await row('authfn_users', signedIn.userId);
      expect(user.primary_email).toBe('owner@example.com');
      expect(user.email_verified_at).toBeNull();
      expect(typeof user.created_at).toBe('number');
      expect(user.created_at).toBeGreaterThanOrEqual(before);
      expect(user.created_at).toBeLessThanOrEqual(after);

      const credentials = await harness.all(
        'SELECT * FROM "authfn_password_credentials" WHERE "user_id" = ?',
        signedIn.userId
      );
      expect(credentials).toHaveLength(1);
      expect(String(credentials[0]!.password_hash)).toMatch(/^scrypt\$/);
      expect(JSON.stringify(credentials)).not.toContain(PASSWORD);
    });

    it('rejects a second sign-up for the same email and keeps a single user row', async () => {
      await signUp('owner@example.com');

      const duplicate = await call('POST', '/sign-up/password', {
        body: { email: 'OWNER@example.com', password: PASSWORD }
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('AUTHFN_CONFLICT');

      const users = await harness.all('SELECT id FROM "authfn_users"');
      expect(users).toHaveLength(1);
    });

    it('reports concurrent sign-ups for one email as a conflict, not an internal error', async () => {
      // Every request passes the existence check before any insert lands, so
      // the unique index rejects the losers.
      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          call('POST', '/sign-up/password', { body: { email: 'race@example.com', password: PASSWORD } })
        )
      );

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
      for (const response of responses.filter((candidate) => candidate.status === 409)) {
        expect(response.body.error).toMatchObject({ code: 'AUTHFN_CONFLICT', retryable: false });
      }
      const winner = responses.find((response) => response.status === 200)!;
      expect(await harness.all('SELECT id FROM "authfn_users"')).toEqual([
        { id: winner.body.data.session.actorId }
      ]);
      expect(await harness.all('SELECT user_id FROM "authfn_password_credentials"')).toEqual([
        { user_id: winner.body.data.session.actorId }
      ]);
    });

    it('enforces the primary email unique index below authfn', async () => {
      await signUp('owner@example.com');
      const now = Date.now();
      await expect(
        harness.exec([
          `INSERT INTO "authfn_users" ("id", "primary_email", "created_at", "updated_at") VALUES ('user_dupe', 'owner@example.com', ${now}, ${now})`
        ])
      ).rejects.toThrow(/UNIQUE/i);
    });

    it('signs in with a password and rejects a wrong password', async () => {
      await signUp('owner@example.com');

      const wrong = await call('POST', '/sign-in/password', {
        body: { email: 'owner@example.com', password: 'not the password at all' }
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('AUTHFN_INVALID_CREDENTIALS');

      const unknown = await call('POST', '/sign-in/password', {
        body: { email: 'nobody@example.com', password: PASSWORD }
      });
      expect(unknown.status).toBe(401);
      expect(unknown.body.error.code).toBe('AUTHFN_INVALID_CREDENTIALS');

      const signedIn = await call('POST', '/sign-in/password', {
        body: { email: 'owner@example.com', password: PASSWORD }
      });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.session).toMatchObject({
        type: 'session',
        actorType: 'user',
        primaryEmail: 'owner@example.com',
        methods: ['password']
      });
      expect(signedIn.setCookies.length).toBeGreaterThan(0);
    });

    it('creates and validates a session, storing JSON and timestamps in SQLite form', async () => {
      const signedIn = await signUp('owner@example.com');

      const stored = await row('authfn_sessions', signedIn.sessionId);
      expect(stored.user_id).toBe(signedIn.userId);
      expect(JSON.parse(String(stored.methods))).toEqual(['password']);
      expect(stored.revoked_at).toBeNull();
      expect(typeof stored.expires_at).toBe('number');
      expect(stored.expires_at).toBeGreaterThan(Date.now());
      // Only hashes of the session and CSRF tokens are stored.
      expect(stored.csrf_hash).toBe(sha256(signedIn.csrf));
      expect(JSON.stringify(stored)).not.toContain(signedIn.csrf);

      const session = await call('GET', '/session', { cookies: signedIn.cookies });
      expect(session.status).toBe(200);
      expect(session.body.data.session).toMatchObject({
        id: signedIn.sessionId,
        actorId: signedIn.userId,
        methods: ['password']
      });
      // Dates come back as Date objects with millisecond precision.
      expect(new Date(session.body.data.session.expiresAt).getTime()).toBe(stored.expires_at);

      const touched = await row('authfn_sessions', signedIn.sessionId);
      expect(typeof touched.last_authenticated_at).toBe('number');
      expect(touched.last_authenticated_at).toBeGreaterThanOrEqual(Number(stored.created_at));
    });

    it('validates a bearer session token and revokes it', async () => {
      await signUp('owner@example.com');
      const signedIn = await call('POST', '/sign-in/password', {
        body: { email: 'owner@example.com', password: PASSWORD, sessionMode: 'bearer' }
      });
      expect(signedIn.status).toBe(200);
      const token = signedIn.body.data.token as string;
      const sessionId = signedIn.body.data.session.id as string;
      expect(token).toBeTruthy();
      expect((await row('authfn_sessions', sessionId)).token_hash).toBe(sha256(token));

      const authenticated = await auth.provider.authenticate(bearerRequest(token));
      expect(authenticated).toMatchObject({ id: sessionId, type: 'session' });

      await auth.revokeSession(sessionId);
      const revoked = await row('authfn_sessions', sessionId);
      expect(typeof revoked.revoked_at).toBe('number');
      await expect(auth.provider.authenticate(bearerRequest(token))).resolves.toBeNull();
    });

    it('revokes the current session on sign-out and a sibling session by id', async () => {
      const first = await signUp('owner@example.com');
      const second = readSignedIn(
        await call('POST', '/sign-in/password', {
          body: { email: 'owner@example.com', password: PASSWORD }
        })
      );

      const listed = await call('GET', '/sessions', { cookies: first.cookies });
      expect(listed.status).toBe(200);
      expect(listed.body.data.sessions.map((session: Json) => session.id).sort()).toEqual(
        [first.sessionId, second.sessionId].sort()
      );

      const revokeSibling = await call('POST', `/sessions/${second.sessionId}/revoke`, {
        cookies: first.cookies,
        csrf: first.csrf
      });
      expect(revokeSibling.status).toBe(200);
      expect((await call('GET', '/session', { cookies: second.cookies })).body.data.session).toBeNull();
      const revokedSibling = await call('GET', '/sessions', { cookies: second.cookies });
      expect(revokedSibling.status).toBe(401);
      expect(revokedSibling.body.error.code).toBe('AUTHFN_SESSION_REVOKED');

      const signOut = await call('POST', '/sign-out', { cookies: first.cookies, csrf: first.csrf, body: {} });
      expect(signOut.status).toBe(200);
      expect(signOut.body.data.revoked).toBe(true);
      expect(typeof (await row('authfn_sessions', first.sessionId)).revoked_at).toBe('number');
      expect((await call('GET', '/session', { cookies: first.cookies })).body.data.session).toBeNull();
    });

    it('treats a session whose stored expiry has passed as expired', async () => {
      const signedIn = await signUp('owner@example.com');
      await harness.exec([
        `UPDATE "authfn_sessions" SET "expires_at" = ${Date.now() - 1_000} WHERE "id" = '${signedIn.sessionId}'`
      ]);

      const session = await call('GET', '/session', { cookies: signedIn.cookies });
      expect(session.status).toBe(200);
      expect(session.body.data.session).toBeNull();

      const sessions = await call('GET', '/sessions', { cookies: signedIn.cookies });
      expect(sessions.status).toBe(401);
      expect(sessions.body.error.code).toBe('AUTHFN_SESSION_EXPIRED');
    });

    it('shows a new API key secret once and stores only its hash', async () => {
      const signedIn = await signUp('owner@example.com');

      const created = await call('POST', '/api-keys', {
        cookies: signedIn.cookies,
        csrf: signedIn.csrf,
        body: { name: 'bookmarks-cli', scopes: ['bookmarks:read', 'bookmarks:write'] }
      });
      expect(created.status).toBe(201);
      expect(created.body.data.secretReturnedOnce).toBe(true);
      const secret = created.body.data.secret as string;
      const keyId = created.body.data.keyId as string;
      expect(secret).toMatch(/^ak_/);

      const stored = await row('authfn_api_keys', keyId);
      expect(stored.secret_hash).toBe(sha256(secret));
      expect(stored.user_id).toBe(signedIn.userId);
      expect(JSON.parse(String(stored.scopes))).toEqual(['bookmarks:read', 'bookmarks:write']);
      expect(stored.last_used_at).toBeNull();
      expect(stored.revoked_at).toBeNull();
      // No column of any authfn table holds the plaintext secret.
      for (const table of ['authfn_api_keys', 'authfn_sessions', 'authfn_users', 'authfn_password_credentials']) {
        expect(JSON.stringify(await harness.all(`SELECT * FROM "${table}"`))).not.toContain(secret);
      }

      const listed = await call('GET', '/api-keys', { cookies: signedIn.cookies });
      expect(listed.status).toBe(200);
      expect(listed.body.data.keys).toEqual([
        expect.objectContaining({ id: keyId, name: 'bookmarks-cli', scopes: ['bookmarks:read', 'bookmarks:write'] })
      ]);
      expect(JSON.stringify(listed.body)).not.toContain(secret);
      expect(JSON.stringify(listed.body)).not.toContain(sha256(secret));
    });

    it('validates an API key and records when it was last used', async () => {
      const signedIn = await signUp('owner@example.com');
      const { keyId, secret } = await createKey(signedIn);

      const before = Date.now();
      const session = await auth.provider.authenticate(bearerRequest(secret));
      expect(session).toMatchObject({
        type: 'api-key',
        actorType: 'api-key',
        actorId: keyId,
        methods: ['api-key'],
        metadata: { ownerUserId: signedIn.userId, scopes: ['bookmarks:read'] }
      });
      const firstUse = await row('authfn_api_keys', keyId);
      expect(typeof firstUse.last_used_at).toBe('number');
      expect(firstUse.last_used_at).toBeGreaterThanOrEqual(before);

      await harness.exec([`UPDATE "authfn_api_keys" SET "last_used_at" = 1 WHERE "id" = '${keyId}'`]);
      await auth.provider.authenticate(bearerRequest(secret));
      expect((await row('authfn_api_keys', keyId)).last_used_at).toBeGreaterThanOrEqual(before);

      await expect(auth.provider.authenticate(bearerRequest(`${secret}x`))).resolves.toBeNull();
    });

    it('revokes an API key only for its owner and rejects it afterwards', async () => {
      const owner = await signUp('owner@example.com');
      const other = await signUp('other@example.com');
      const { keyId, secret } = await createKey(owner);

      const foreign = await call('DELETE', `/api-keys/${keyId}`, { cookies: other.cookies, csrf: other.csrf });
      expect(foreign.status).toBe(404);
      expect((await row('authfn_api_keys', keyId)).revoked_at).toBeNull();

      const revoked = await call('DELETE', `/api-keys/${keyId}`, { cookies: owner.cookies, csrf: owner.csrf });
      expect(revoked.status).toBe(200);
      expect(revoked.body.data).toEqual({ revoked: true, keyId });
      expect(typeof (await row('authfn_api_keys', keyId)).revoked_at).toBe('number');

      await expect(auth.provider.authenticate(bearerRequest(secret))).rejects.toMatchObject({
        code: 'AUTHFN_API_KEY_REVOKED'
      });
      const viaRoute = await call('GET', '/account', { bearer: secret });
      expect(viaRoute.status).toBe(401);
      expect(viaRoute.body.error.code).toBe('AUTHFN_API_KEY_REVOKED');
    });

    it('stops accepting an API key at its stored expiry', async () => {
      const signedIn = await signUp('owner@example.com');
      const expiresAt = new Date(Date.now() + 60_000);
      const { keyId, secret } = await createKey(signedIn, { expiresAt: expiresAt.toISOString() });

      expect((await row('authfn_api_keys', keyId)).expires_at).toBe(expiresAt.getTime());
      await expect(auth.provider.authenticate(bearerRequest(secret))).resolves.toMatchObject({
        actorId: keyId,
        expiresAt
      });

      await harness.exec([
        `UPDATE "authfn_api_keys" SET "expires_at" = ${Date.now() - 1_000}, "last_used_at" = NULL WHERE "id" = '${keyId}'`
      ]);
      await expect(auth.provider.authenticate(bearerRequest(secret))).resolves.toBeNull();
      expect((await row('authfn_api_keys', keyId)).last_used_at).toBeNull();
    });

    async function createKey(
      signedIn: SignedIn,
      extra: Record<string, unknown> = {}
    ): Promise<{ keyId: string; secret: string }> {
      const created = await call('POST', '/api-keys', {
        cookies: signedIn.cookies,
        csrf: signedIn.csrf,
        body: { name: 'bookmarks-cli', scopes: ['bookmarks:read'], ...extra }
      });
      expect(created.status).toBe(201);
      return { keyId: created.body.data.keyId, secret: created.body.data.secret };
    }
  });
}

function readSignedIn(response: CallResult): SignedIn {
  const pairs = response.setCookies.map((cookie) => cookie.slice(0, cookie.indexOf(';')));
  const csrfPair = pairs.find((pair) => pair.startsWith('authfn.csrf='));
  expect(csrfPair).toBeDefined();
  return {
    cookies: pairs.join('; '),
    csrf: decodeURIComponent(csrfPair!.slice('authfn.csrf='.length)),
    userId: response.body.data.session.actorId,
    sessionId: response.body.data.session.id
  };
}

function bearerRequest(secret: string): Request {
  return new Request(`${ORIGIN}/auth/session`, {
    headers: { authorization: `Bearer ${secret}` }
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
