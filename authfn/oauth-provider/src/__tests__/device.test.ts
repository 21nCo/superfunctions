import { describe, expect, it } from 'vitest';
import { hashSecret, issueSession } from 'authfn/core/sessions';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { createUser } from 'authfn/core/users';
import {
  disconnectOAuthClient,
  OAUTH_DEVICE_CODE_GRANT_TYPE,
  verifyOAuthAccessToken,
  type OAuthProviderClient
} from '../index.js';
import { createDeviceSchema, OAUTH_DEVICE_CODE_TTL_SECONDS } from '../device/index.js';
import { createDeviceCode, findDeviceCode } from '../device/store.js';
import { OAUTH_REFRESH_TOKEN_TTL_SECONDS } from '../types.js';
import { createOAuthProviderSchema } from '../store.js';
import {
  MEMOTRON,
  ORIGIN,
  POINTRON,
  RESOURCES,
  RFC6749_BASIC,
  RFC6749_CLIENT,
  createInsertControl,
  createProviderApp,
  setupProvider
} from './harness.js';

/** A public CLI client, configured ahead of time. */
const CLI: OAuthProviderClient = {
  clientId: 'memotron-cli',
  name: 'Memotron CLI',
  redirectUris: ['http://127.0.0.1/callback']
};

const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function setupDevice(options: Parameters<typeof setupProvider>[0] = {}) {
  const provider = await setupProvider({ clients: [CLI], device: {}, ...options });

  const requestDeviceCode = (form: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    provider.handle('/auth/oauth/device_authorization', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ client_id: CLI.clientId, resource: MEMOTRON, ...form })
    });

  const start = async (form: Record<string, string> = {}): Promise<DeviceAuthorization> => {
    const response = await requestDeviceCode(form);
    if (response.status !== 200) {
      throw new Error(`device authorization failed with ${response.status}: ${await response.text()}`);
    }
    return await response.json() as DeviceAuthorization;
  };

  /** Opens the verification page, optionally with `user_code`, and returns what it rendered. */
  const openPage = async (userCode?: string) => {
    const query = userCode === undefined ? '' : `?${new URLSearchParams({ user_code: userCode })}`;
    const response = await provider.handle(`/auth/oauth/device${query}`, { headers: { cookie: provider.cookie } });
    return { response, input: provider.verifications[provider.verifications.length - 1] };
  };

  const decide = (userCode: string, decision: 'approve' | 'deny', csrf = provider.session.csrfToken) =>
    provider.handle('/auth/oauth/device', {
      method: 'POST',
      headers: { cookie: provider.cookie, 'content-type': 'application/json', 'x-authfn-csrf': csrf },
      body: JSON.stringify({ user_code: userCode, decision })
    });

  const poll = (deviceCode: string, clientId = CLI.clientId) =>
    provider.token({ grant_type: OAUTH_DEVICE_CODE_GRANT_TYPE, device_code: deviceCode, client_id: clientId });

  const pollError = async (deviceCode: string) => {
    const response = await poll(deviceCode);
    expect(response.status).toBe(400);
    return (await response.json() as { error: string }).error;
  };

  /** The stored row of a device code. */
  const row = (deviceCode: string) => provider.database.findOne<{ interval: number; decision?: string | null }>({
    model: 'oauth_provider_device_codes',
    where: [{ field: 'deviceCodeHash', operator: 'eq', value: hashSecret(deviceCode) }],
    namespace: 'authfn'
  });

  /** Every access and refresh token stored for the CLI, usable or not. */
  const cliTokens = () => provider.database.findMany({
    model: 'oauth_provider_tokens',
    where: [{ field: 'clientId', operator: 'eq', value: CLI.clientId }],
    namespace: 'authfn'
  });

  const disconnect = () => disconnectOAuthClient(
    { database: provider.database },
    { userId: provider.user.id, clientId: CLI.clientId, resource: MEMOTRON, now: provider.now }
  );

  return { ...provider, requestDeviceCode, start, openPage, decide, poll, pollError, row, cliTokens, disconnect };
}

describe('device authorization grant (RFC 8628)', () => {
  it('issues the same audience-bound, scoped tokens as an authorization code after the user approves', async () => {
    const provider = await setupDevice();
    const metadata = await (await provider.handle('/auth/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    expect(metadata.device_authorization_endpoint).toBe(`${ORIGIN}/auth/oauth/device_authorization`);
    expect(metadata.grant_types_supported).toContain(OAUTH_DEVICE_CODE_GRANT_TYPE);

    const response = await provider.requestDeviceCode({ scope: 'memotron:read' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const device = await response.json() as DeviceAuthorization;
    expect(device).toMatchObject({
      verification_uri: `${ORIGIN}/auth/oauth/device`,
      verification_uri_complete: `${ORIGIN}/auth/oauth/device?user_code=${device.user_code}`,
      expires_in: 600,
      interval: 5
    });
    expect(device.user_code).toMatch(USER_CODE);
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');

    // The user opens verification_uri_complete, sees the request, and approves.
    const { response: page, input } = await provider.openPage(device.user_code);
    expect(page.status).toBe(200);
    expect(input).toMatchObject({
      user: { id: provider.user.id },
      userCode: device.user_code,
      authorization: { client: { clientId: CLI.clientId, name: 'Memotron CLI', trusted: false }, resource: MEMOTRON, scopes: ['memotron:read'] },
      decisionUrl: `${ORIGIN}/auth/oauth/device`
    });
    expect(input.error).toBeUndefined();
    const decided = await provider.decide(device.user_code, 'approve');
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ data: { decision: 'approved' } });

    provider.advance(5);
    const tokenResponse = await provider.poll(device.device_code);
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('cache-control')).toBe('no-store');
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'memotron:read' });
    expect((await provider.introspect(tokens.access_token)).body).toMatchObject({
      active: true, aud: MEMOTRON, sub: provider.user.id, client_id: CLI.clientId, scope: 'memotron:read'
    });
    const info = await verifyOAuthAccessToken({ database: provider.database }, tokens.access_token, { resource: MEMOTRON, now: provider.now });
    expect(info).toMatchObject({ userId: provider.user.id, clientId: CLI.clientId, scopes: ['memotron:read'] });

    // The refresh token rotates like any other.
    const refreshed = await provider.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLI.clientId });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { access_token: string };

    // The device code works once: presenting it again revokes the grant.
    provider.advance(5);
    expect(await provider.pollError(device.device_code)).toBe('invalid_grant');
    expect((await provider.introspect(rotated.access_token)).body).toEqual({ active: false });

    // Disconnecting the app revokes a device grant like any other.
    const second = await provider.start();
    await provider.decide(second.user_code, 'approve');
    const secondTokens = await (await provider.poll(second.device_code)).json() as { access_token: string };
    expect(await disconnectOAuthClient({ database: provider.database }, { userId: provider.user.id, clientId: CLI.clientId, resource: MEMOTRON, now: provider.now })).toBe(1);
    expect((await provider.introspect(secondTokens.access_token)).body).toEqual({ active: false });
  });

  it('validates the device authorization request', async () => {
    const provider = await setupDevice({ registration: { dynamic: true } });
    const expectError = async (response: Response, status: number, error: string) => {
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    };
    await expectError(await provider.requestDeviceCode({ resource: '' }), 400, 'invalid_target');
    await expectError(await provider.requestDeviceCode({ resource: 'https://other.example.com/mcp' }), 400, 'invalid_target');
    await expectError(await provider.requestDeviceCode({ scope: 'pointron:read' }), 400, 'invalid_scope');
    await expectError(await provider.requestDeviceCode({ client_id: 'unknown' }), 400, 'invalid_client');
    // A confidential client authenticates as at the token endpoint.
    await expectError(await provider.requestDeviceCode({ client_id: RFC6749_CLIENT.clientId }), 400, 'invalid_client');
    const confidential = await provider.requestDeviceCode({ client_id: RFC6749_CLIENT.clientId, resource: POINTRON }, { authorization: RFC6749_BASIC });
    expect(confidential.status).toBe(200);

    // A self-registered client did not register for the device grant.
    const registered = await provider.register({ redirect_uris: ['https://host.example.com/cb'] });
    const { client_id: registeredId } = await registered.json() as { client_id: string };
    await expectError(await provider.requestDeviceCode({ client_id: registeredId }), 400, 'unauthorized_client');

    // A device code is bound to its client and its resource; neither
    // mismatch spends it.
    const device = await provider.start();
    await provider.decide(device.user_code, 'approve');
    const stolen = await provider.poll(device.device_code, 'mcp-host');
    await expectError(stolen, 400, 'invalid_grant');
    const form = { grant_type: OAUTH_DEVICE_CODE_GRANT_TYPE, device_code: device.device_code, client_id: CLI.clientId };
    await expectError(await provider.token({ ...form, resource: POINTRON }), 400, 'invalid_target');
    expect((await provider.token({ ...form, resource: MEMOTRON })).status).toBe(200);
  });

  it('refuses to start with a malformed deviceAuthorization config', () => {
    const create = (deviceAuthorization: unknown) => createProviderApp().createServer({
      database: memoryAdapter({ debug: false }),
      pluginRuntime: {
        oauthProvider: {
          clients: [], resources: RESOURCES, deviceAuthorization,
          loginRequired: () => new Response(null), consent: () => new Response(null)
        }
      }
    });
    const invalid = expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' });
    const verification = () => new Response(null);
    expect(() => create({ verification, authorizationRateLimit: { perIp: 0 } })).toThrow(invalid);
    expect(() => create({ verification, authorizationRateLimit: { perUser: 5 } })).toThrow(invalid);
    expect(() => create({ verification, resolveClientIp: 'x-forwarded-for' })).toThrow(invalid);
    expect(() => create({ verification, authorizationRateLimit: { perIp: 5, global: undefined }, resolveClientIp: () => '203.0.113.1' })).not.toThrow();
  });

  it('is off unless configured: no endpoints, no grant type, nothing advertised', async () => {
    const provider = await setupProvider({ clients: [CLI] });
    const metadata = await (await provider.handle('/auth/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('device_authorization_endpoint');
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    const response = await provider.handle('/auth/oauth/device_authorization', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLI.clientId, resource: MEMOTRON })
    });
    // The route does not exist: it answers like any unknown path.
    const unknown = await provider.handle('/auth/oauth/no_such_route', { method: 'POST' });
    expect(response.status).toBe(unknown.status);
    expect(response.status).not.toBe(200);
    const token = await provider.token({ grant_type: OAUTH_DEVICE_CODE_GRANT_TYPE, device_code: 'x', client_id: CLI.clientId });
    expect(await token.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('serves the verification page only to a signed-in user and normalizes the typed code', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    const anonymous = await provider.handle(`/auth/oauth/device?user_code=${device.user_code}`);
    expect(anonymous.status).toBe(401);
    expect(provider.logins[0].returnTo).toBe(`${ORIGIN}/auth/oauth/device?user_code=${device.user_code}`);
    expect(provider.verifications).toHaveLength(0);

    const empty = await provider.openPage();
    expect(empty.input).toMatchObject({ verificationUrl: `${ORIGIN}/auth/oauth/device` });
    expect(empty.input.userCode).toBeUndefined();
    expect(empty.input.authorization).toBeUndefined();

    // Lowercase, without the dash, with spaces: the same code.
    const typed = ` ${device.user_code.replace('-', '').toLowerCase().slice(0, 4)} ${device.user_code.slice(5).toLowerCase()}`;
    expect((await provider.openPage(typed)).input).toMatchObject({ userCode: device.user_code, authorization: { resource: MEMOTRON } });
    expect((await provider.openPage('not-a-code')).input).toMatchObject({ error: 'invalid_user_code' });

    // The decision needs the CSRF header.
    expect((await provider.decide(device.user_code, 'approve', 'wrong')).status).toBe(403);
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
  });

  it.each(['resumes', 'never resumes'] as const)(
    'an approval overlapping a disconnect publishes nothing exchangeable before its generation check (approval %s)',
    async (mode) => {
      const provider = await setupDevice();
      const device = await provider.start();
      // The approval reads the generation, then pauses before creating its
      // grant while the app is disconnected.
      const atGrant = provider.control.arm('oauth_provider_grants');
      const decision = provider.decide(device.user_code, 'approve');
      await atGrant;
      await provider.disconnect();
      // It creates the grant and pauses again at its second generation read.
      provider.control.release();
      const atCheck = provider.control.arm('oauth_provider_disconnects', 'findMany');
      await atCheck;
      // The device polls meanwhile: nothing has been published to it.
      expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
      if (mode === 'resumes') {
        provider.control.release();
        const response = await decision;
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'access_denied' });
        expect((await provider.row(device.device_code))?.decision).toBe('denied');
        provider.advance(5);
        expect(await provider.pollError(device.device_code)).toBe('access_denied');
      } else {
        provider.advance(5);
        expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
        provider.advance(600);
        expect(await provider.pollError(device.device_code)).toBe('expired_token');
      }
      expect(await provider.cliTokens()).toHaveLength(0);
    }
  );

  it.each(['resumes', 'never resumes'] as const)(
    'a disconnect after the approval\'s generation check revokes its grant; the device gets access_denied (approval %s)',
    async (mode) => {
      const provider = await setupDevice();
      const device = await provider.start();
      // The approval has created its grant and checked the generation; it
      // pauses before recording the decision while the app is disconnected.
      const atDecision = provider.control.arm('oauth_provider_device_codes', 'updateMany', ({ data }) => data?.decision === 'approved');
      const decision = provider.decide(device.user_code, 'approve');
      await atDecision;
      expect(await provider.disconnect()).toBe(1);
      expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
      provider.advance(5);
      if (mode === 'resumes') {
        provider.control.release();
        expect((await decision).status).toBe(200);
        expect(await provider.pollError(device.device_code)).toBe('access_denied');
      } else {
        expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
      }
      expect(await provider.cliTokens()).toHaveLength(0);
    }
  );

  it('a device code claim write that fails before applying leaves the code redeemable, not replayed', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    await provider.decide(device.user_code, 'approve');
    provider.control.failNext('oauth_provider_device_codes', ({ data }) => data?.consumedAt !== undefined, 'updateManyRejected');
    expect((await provider.poll(device.device_code)).status).toBe(500);
    provider.advance(5);
    const response = await provider.poll(device.device_code);
    expect(response.status).toBe(200);
    const tokens = await response.json() as { access_token: string };
    expect((await provider.introspect(tokens.access_token)).body).toMatchObject({ active: true });
  });

  it('keeps the device code table in a custom schema that predates the device grant', async () => {
    const deviceModels = createDeviceSchema().map((table) => table.modelName);
    const schema = createOAuthProviderSchema().filter((table) => !deviceModels.includes(table.modelName));
    const models = createProviderApp({ schema }).getSchema().schemas.map((table) => table.modelName);
    expect(models).toEqual(expect.arrayContaining(deviceModels));
    expect(new Set(models).size).toBe(models.length);

    const provider = await setupDevice({ sql: true, plugin: { schema } });
    const device = await provider.start();
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
    expect((await provider.decide(device.user_code, 'approve')).status).toBe(200);
    provider.advance(5);
    const tokens = await (await provider.poll(device.device_code)).json() as { access_token: string };
    expect((await provider.introspect(tokens.access_token)).body).toMatchObject({ active: true, client_id: CLI.clientId });
  });
});

describe('in-scope actors (AUTH-9)', () => {
  it.each([false, true])('polling too fast: a poll within the interval gets slow_down and adds 5 seconds (sql: %s)', async (sql) => {
    const provider = await setupDevice({ sql });
    const device = await provider.start();
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
    provider.advance(4);
    expect(await provider.pollError(device.device_code)).toBe('slow_down');
    // The interval is now 10 seconds, counted from the slowed poll; a second
    // slow_down makes it 15.
    provider.advance(9);
    expect(await provider.pollError(device.device_code)).toBe('slow_down');
    provider.advance(15);
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');

    // Of concurrent polls only one is answered; the others are too fast and
    // each adds 5 seconds: 15 + 5 + 5.
    provider.advance(15);
    const results = await Promise.all([1, 2, 3].map(async () => (await (await provider.poll(device.device_code)).json() as { error: string }).error));
    expect(results.sort()).toEqual(['authorization_pending', 'slow_down', 'slow_down']);
    expect((await provider.row(device.device_code))?.interval).toBe(25);
    provider.advance(24);
    expect(await provider.pollError(device.device_code)).toBe('slow_down');

    // Even approved, a fast poll gets no tokens.
    await provider.decide(device.user_code, 'approve');
    expect(await provider.pollError(device.device_code)).toBe('slow_down');
    provider.advance(60);
    expect((await provider.poll(device.device_code)).status).toBe(200);
  });

  it('expired code: after 10 minutes the device gets expired_token and the user cannot approve', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    provider.advance(599);
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
    provider.advance(1);
    expect((await provider.openPage(device.user_code)).input).toMatchObject({ error: 'expired_user_code' });
    expect((await provider.openPage(device.user_code)).input.authorization).toBeUndefined();
    const decided = await provider.decide(device.user_code, 'approve');
    expect(decided.status).toBe(400);
    expect(await decided.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await provider.pollError(device.device_code)).toBe('expired_token');

    // A code approved in time but not exchanged before it expires is also spent.
    const late = await provider.start();
    await provider.decide(late.user_code, 'approve');
    provider.advance(600);
    expect(await provider.pollError(late.device_code)).toBe('expired_token');
  });

  it('denied request: the device gets access_denied and the code cannot be decided again', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    const denied = await provider.decide(device.user_code, 'deny');
    expect(await denied.json()).toMatchObject({ data: { decision: 'denied' } });
    expect(await provider.pollError(device.device_code)).toBe('access_denied');
    provider.advance(5);
    expect(await provider.pollError(device.device_code)).toBe('access_denied');

    // Approving afterwards changes nothing; the page no longer offers the request.
    const again = await provider.decide(device.user_code, 'approve');
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.openPage(device.user_code)).input).toMatchObject({ error: 'invalid_user_code' });
    provider.advance(5);
    expect(await provider.pollError(device.device_code)).toBe('access_denied');

    // Of two concurrent decisions on one code, exactly one is recorded, and
    // the approval that loses leaves no live grant behind.
    const raced = await provider.start();
    const decisions = await Promise.all([provider.decide(raced.user_code, 'deny'), provider.decide(raced.user_code, 'approve')]);
    const outcomes = await Promise.all(decisions.map(async (response) => (await response.json() as { data?: { decision: string } }).data?.decision ?? response.status));
    expect(outcomes.filter((outcome) => outcome === 'denied' || outcome === 'approved')).toHaveLength(1);
    const grants = await provider.database.findMany<{ revokedAt?: Date | null }>({
      model: 'oauth_provider_grants',
      where: [{ field: 'clientId', operator: 'eq', value: CLI.clientId }],
      namespace: 'authfn'
    });
    expect(grants.filter((grant) => !grant.revokedAt)).toHaveLength(outcomes.includes('approved') ? 1 : 0);
  });

  it('anonymous device authorization requests are limited per client IP and overall; expired unused codes are pruned', async () => {
    const provider = await setupDevice({
      device: { authorizationRateLimit: { perIp: 2, global: 3 }, resolveClientIp: (request) => request.headers.get('x-test-ip') }
    });
    const rows = () => provider.database.findMany({ model: 'oauth_provider_device_codes', namespace: 'authfn' });
    const from = (ip: string) => provider.requestDeviceCode({}, { 'x-test-ip': ip });
    const first = await (await from('203.0.113.1')).json() as DeviceAuthorization;
    expect((await from('203.0.113.1')).status).toBe(200);
    const refused = await from('203.0.113.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('600');
    expect(await refused.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect((await from('203.0.113.2')).status).toBe(200);
    // The overall limit holds across IPs.
    expect((await from('203.0.113.3')).status).toBe(429);
    // Refused requests stored no code.
    expect(await rows()).toHaveLength(3);

    // One code is exchanged; the other two are never used.
    await provider.decide(first.user_code, 'approve');
    const tokens = await (await provider.poll(first.device_code)).json() as { access_token: string };
    // Codes expire after 600 seconds and are pruned a lifetime later.
    provider.advance(1200);
    expect((await from('203.0.113.1')).status).toBe(200);
    expect(await rows()).toHaveLength(4);
    provider.advance(1);
    expect((await from('203.0.113.1')).status).toBe(200);
    // The exchanged code stays, since its tokens are valid only while it exists.
    expect(await rows()).toHaveLength(3);
    expect(await provider.row(first.device_code)).not.toBeNull();
    expect((await provider.introspect(tokens.access_token)).body).toMatchObject({ active: true });
  });

  it('user-code brute force: lookups are limited per user and overall, found or not', async () => {
    const provider = await setupDevice({ device: { rateLimit: { perUser: 3, global: 100, windowSeconds: 600 } } });
    const device = await provider.start();
    // Wrong guesses use up the window.
    for (const guess of ['BBBB-BBBB', 'CCCC-CCCC', 'DDDD-DDDD']) {
      expect((await provider.openPage(guess)).input).toMatchObject({ error: 'invalid_user_code' });
    }
    // Then even the right code is refused, on the page and at the decision endpoint.
    expect((await provider.openPage(device.user_code)).input).toMatchObject({ error: 'too_many_attempts', retryAfterSeconds: 600 });
    expect((await provider.openPage(device.user_code)).input.authorization).toBeUndefined();
    const decided = await provider.decide(device.user_code, 'approve');
    expect(decided.status).toBe(429);
    expect(decided.headers.get('retry-after')).toBe('600');
    expect(await decided.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');

    // A new window admits lookups again.
    provider.advance(600);
    const fresh = await provider.start();
    expect((await provider.openPage(fresh.user_code)).input).toMatchObject({ authorization: { resource: MEMOTRON } });

    // The overall limit holds across users.
    const shared = await setupDevice({ device: { rateLimit: { perUser: 100, global: 2 } } });
    const other = await createUser(shared.coreConfig, { primaryEmail: 'other@example.com' });
    const session = await issueSession(shared.coreConfig, {}, { userId: other.id, methods: ['password'] });
    const names = await shared.server.cookieNamesForRequest(new Request(`${ORIGIN}/auth/session`));
    const otherCookie = `${names.sessionCookieName}=${session.sessionToken}; ${names.csrfCookieName}=${session.csrfToken}`;
    await shared.openPage('BBBB-BBBB');
    await shared.openPage('CCCC-CCCC');
    await shared.handle('/auth/oauth/device?user_code=DDDD-DDDD', { headers: { cookie: otherCookie } });
    expect(shared.verifications.at(-1)).toMatchObject({ user: { id: other.id }, error: 'too_many_attempts' });
  });
});

describe('device grant storage and request bounds', () => {
  const DEVICE_CODES = 'oauth_provider_device_codes';
  const errorOf = async (response: Promise<Response>) => (await (await response).json() as { error: string }).error;

  it.each([false, true])('each poll has one outcome, stored once, against a last poll time that never moves back (sql: %s)', async (sql) => {
    const provider = await setupDevice({ sql });
    const device = await provider.start();
    const interval = async () => (await provider.row(device.device_code))?.interval;
    const pollWrite = ({ data }: { data?: Record<string, unknown> }) => data?.pollClaim !== undefined;

    // A commits its poll, then B commits over it before A reads its write back:
    // A was admitted, B was too fast, and the interval grew once.
    let paused = provider.control.arm(DEVICE_CODES, 'updateManyApplied', pollWrite);
    const a = errorOf(provider.poll(device.device_code));
    await paused;
    expect(await provider.pollError(device.device_code)).toBe('slow_down');
    provider.control.release();
    expect(await a).toBe('authorization_pending');
    expect(await interval()).toBe(10);

    // Both early, the same way: two slow_down answers, two increments.
    provider.advance(1);
    paused = provider.control.arm(DEVICE_CODES, 'updateManyApplied', pollWrite);
    const early = errorOf(provider.poll(device.device_code));
    await paused;
    expect(await provider.pollError(device.device_code)).toBe('slow_down');
    provider.control.release();
    expect(await early).toBe('slow_down');
    expect(await interval()).toBe(20);

    // A poll that read the clock before a later poll committed does not move
    // the last poll time back, so the poll after it is still judged from the later one.
    provider.advance(20);
    paused = provider.control.arm(DEVICE_CODES, 'updateMany', pollWrite);
    const delayed = errorOf(provider.poll(device.device_code));
    await paused;
    provider.advance(25);
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
    provider.control.release();
    expect(await delayed).toBe('slow_down');
    expect(await interval()).toBe(25);
    provider.advance(24);
    expect(await provider.pollError(device.device_code)).toBe('slow_down');

    // Many concurrent polls: at most one admitted, every other answer a stored slow_down.
    provider.advance(60);
    const before = await interval() as number;
    const answers = await Promise.all(Array.from({ length: 12 }, () => errorOf(provider.poll(device.device_code))));
    const slowed = answers.filter((answer) => answer === 'slow_down').length;
    expect(answers.filter((answer) => answer === 'authorization_pending').length).toBeLessThanOrEqual(1);
    expect(slowed + answers.filter((answer) => answer === 'authorization_pending').length).toBe(12);
    expect(await interval()).toBe(before + 5 * slowed);
  });

  it.each([
    ['lost', 'updateMany', 'admitted'],
    ['committed', 'updateManyApplied', 'admitted'],
    ['lost', 'updateMany', 'slowed'],
    ['committed', 'updateManyApplied', 'slowed']
  ] as const)(
    'a poll that cannot tell whether its %s write (%s) was stored, after 16 others were, is neither admitted nor slowed and is told when to retry (own poll %s)',
    async (_write, operation, own) => {
      const provider = await setupDevice();
      const device = await provider.start();
      if (own === 'slowed') {
        expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
      }
      const paused = provider.control.arm(DEVICE_CODES, operation, ({ data }) => data?.pollClaim !== undefined);
      const a = provider.poll(device.device_code);
      await paused;
      const others: string[] = [];
      for (let poll = 0; poll < 16; poll += 1) {
        others.push(await errorOf(provider.poll(device.device_code)));
      }
      provider.control.release();
      const response = await a;
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
      // Every slow_down answered is exactly one stored increment, and A's own
      // increment is stored when its slow_down committed.
      const slowed = others.filter((answer) => answer === 'slow_down').length;
      const ownStored = own === 'slowed' && operation === 'updateManyApplied';
      expect(slowed).toBe(own === 'admitted' && operation === 'updateMany' ? 15 : 16);
      const interval = (await provider.row(device.device_code))?.interval as number;
      expect(interval).toBe(5 + 5 * slowed + (ownStored ? 5 : 0));
      // Retry-After is the stored interval, plus 5 when A's own slow_down may count;
      // a poll that waits that long is not too fast.
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBe(interval + (own === 'slowed' ? 5 : 0));
      provider.advance(retryAfter);
      expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
    }
  );

  it('a poll that loses every round to concurrent polls is told to retry once it would no longer be too fast', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    const pollWrite = ({ data }: { data?: Record<string, unknown> }) => data?.pollClaim !== undefined;
    let paused = provider.control.arm(DEVICE_CODES, 'updateMany', pollWrite);
    const busy = provider.poll(device.device_code);
    await paused;
    // In each of its 16 rounds another poll commits between its read and its conditional write.
    for (let round = 1; round <= 16; round += 1) {
      await provider.poll(device.device_code);
      if (round < 16) {
        paused = provider.control.arm(DEVICE_CODES, 'updateMany', pollWrite);
      }
      provider.control.release();
      if (round < 16) {
        await paused;
      }
    }
    const response = await busy;
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    const interval = (await provider.row(device.device_code))?.interval;
    expect(interval).toBe(5 + 5 * 15);
    expect(Number(response.headers.get('retry-after'))).toBe(interval);
    provider.advance(interval as number);
    expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
  });

  // The poll reads its clock at T; the concurrent polls are stored with their
  // own clock at T + offset (another instance behind or ahead) and raise the
  // interval to 80. Retry-After is the time left until that last poll time
  // plus 80, crediting time already elapsed: 50, 0, 80 and 100 seconds.
  it.each(
    (['busy', 'unknown-outcome'] as const).flatMap((outcome) => ([
      ['30 s before', -30, 50],
      ['100 s before (interval elapsed)', -100, 0],
      ['equal to', 0, 80],
      ['20 s after', 20, 100]
    ] as const).flatMap(([at, offset, wait]) =>
      [false, true].map((sql) => [outcome, at, offset, wait, sql] as const)))
  )(
    '%s 429 poll with the stored last poll time %s its clock (%d s) gets Retry-After %d, after which it is not too fast (sql: %s)',
    async (outcome, _at, offset, wait, sql) => {
      const provider = await setupDevice({ sql });
      const device = await provider.start();
      const pollWrite = ({ data }: { data?: Record<string, unknown> }) => data?.pollClaim !== undefined;
      provider.advance(200);
      let paused = provider.control.arm(DEVICE_CODES, 'updateMany', pollWrite);
      const slow = provider.poll(device.device_code);
      await paused;
      provider.advance(offset);
      for (let round = 1; round <= 16; round += 1) {
        await provider.poll(device.device_code);
        if (outcome === 'busy') {
          // Another poll commits between each of its 16 reads and conditional writes.
          if (round < 16) {
            paused = provider.control.arm(DEVICE_CODES, 'updateMany', pollWrite);
          }
          provider.control.release();
          if (round < 16) {
            await paused;
          }
        }
      }
      if (outcome === 'unknown-outcome') {
        // 16 polls were stored while its write waited: it cannot tell whether it lost.
        provider.control.release();
      }
      const response = await slow;
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
      expect((await provider.row(device.device_code))?.interval).toBe(80);
      expect(Number(response.headers.get('retry-after'))).toBe(wait);
      // A poll at the slow poll's clock plus Retry-After is not too fast.
      provider.advance(wait - offset);
      expect(await provider.pollError(device.device_code)).toBe('authorization_pending');
    }
  );

  it.each(['before its grant is created', 'before its decision is recorded', 'while its decision is written'] as const)(
    'an approval that crosses the code\'s expiry %s is refused and leaves no live grant',
    async (boundary) => {
      const provider = await setupDevice();
      const device = await provider.start();
      const atGrant = provider.control.arm('oauth_provider_grants');
      const decision = provider.decide(device.user_code, 'approve');
      await atGrant;
      if (boundary === 'before its decision is recorded') {
        provider.control.release();
        await provider.control.arm('oauth_provider_disconnects', 'findMany');
      } else if (boundary === 'while its decision is written') {
        provider.control.release();
        await provider.control.arm(DEVICE_CODES, 'updateMany', ({ data }) => data?.decision === 'approved');
      }
      provider.advance(600);
      provider.control.release();
      const response = await decision;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await provider.row(device.device_code))?.decision ?? null).toBe(boundary === 'while its decision is written' ? 'approved' : null);
      const grants = await provider.database.findMany<{ revokedAt?: Date | null }>({
        model: 'oauth_provider_grants',
        where: [{ field: 'clientId', operator: 'eq', value: CLI.clientId }],
        namespace: 'authfn'
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].revokedAt).toBeTruthy();
      expect(await provider.pollError(device.device_code)).toBe('expired_token');
      expect(await provider.cliTokens()).toHaveLength(0);
    }
  );

  it.each([false, true])(
    'a poll that read its clock before an approval was published at expiry gets expired_token, and the approval is closed (sql: %s)',
    async (sql) => {
      const provider = await setupDevice({ sql });
      const device = await provider.start();
      provider.advance(599);
      // The approval passes its expiry check at 599s and pauses before its decision applies.
      const beforeDecision = provider.control.arm(DEVICE_CODES, 'updateMany', ({ data }) => data?.decision === 'approved');
      const decision = provider.decide(device.user_code, 'approve');
      await beforeDecision;
      // A poll reads the clock at 599s and pauses before it reads the row.
      const beforeRead = provider.control.arm(DEVICE_CODES, 'findOne', ({ where }) =>
        where?.some(({ field }) => field === 'deviceCodeHash') === true);
      const polled = provider.poll(device.device_code);
      await beforeRead;
      const afterDecision = provider.control.arm(DEVICE_CODES, 'updateManyApplied', ({ data }) => data?.decision === 'approved');
      provider.advance(1);
      provider.control.release(); // the decision is published at 600s
      await afterDecision;
      provider.control.release(); // the poll reads the approved row
      const response = await polled;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'expired_token' });
      provider.control.release(); // the approval checks expiry after its write
      const decided = await decision;
      expect(decided.status).toBe(400);
      expect(await decided.json()).toMatchObject({ error: 'invalid_grant' });
      const stored = await provider.database.findOne<{ claimId?: string | null }>({
        model: DEVICE_CODES,
        where: [{ field: 'deviceCodeHash', operator: 'eq', value: hashSecret(device.device_code) }],
        namespace: 'authfn'
      });
      expect(stored?.claimId).toMatch(/^odx_/);
      const grants = await provider.database.findMany<{ revokedAt?: Date | null }>({
        model: 'oauth_provider_grants',
        where: [{ field: 'clientId', operator: 'eq', value: CLI.clientId }],
        namespace: 'authfn'
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].revokedAt).toBeTruthy();
      expect(await provider.cliTokens()).toHaveLength(0);
      expect(await provider.pollError(device.device_code)).toBe('expired_token');
    }
  );

  it('an approval whose decision is written in time keeps the tokens the device exchanged before the code expired', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    const written = provider.control.arm(DEVICE_CODES, 'updateManyApplied', ({ data }) => data?.decision === 'approved');
    const decision = provider.decide(device.user_code, 'approve');
    await written;
    provider.advance(599);
    const exchanged = await provider.poll(device.device_code);
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json() as { access_token: string };
    provider.advance(1);
    provider.control.release();
    expect(await (await decision).json()).toMatchObject({ data: { decision: 'approved' } });
    expect((await provider.introspect(tokens.access_token)).body).toMatchObject({ active: true });
  });

  it('a device code insert whose acknowledgement is lost is returned, a failed one is not retried, and only a taken user code is replaced', async () => {
    const provider = await setupDevice();
    const rows = () => provider.database.findMany({ model: DEVICE_CODES, namespace: 'authfn' });

    provider.control.failNext(DEVICE_CODES, () => true, 'createCommitted');
    const committed = await provider.start();
    expect(await rows()).toHaveLength(1);
    expect(await provider.pollError(committed.device_code)).toBe('authorization_pending');

    provider.control.failNext(DEVICE_CODES, () => true, 'create');
    expect((await provider.requestDeviceCode()).status).toBe(500);
    expect(await rows()).toHaveLength(1);

    // Another row takes the generated user code just before the insert.
    let collided = false;
    const database = {
      ...provider.database,
      create: async (params: Parameters<typeof provider.database.create>[0]) => {
        if (!collided && params.model === DEVICE_CODES) {
          collided = true;
          await provider.database.create({ ...params, data: { ...params.data, id: 'odv_other', deviceCodeHash: 'other' } });
          throw new Error('unique violation');
        }
        return provider.database.create(params);
      }
    } as typeof provider.database;
    const created = await createDeviceCode({ database }, { clientId: CLI.clientId, resource: MEMOTRON, scopes: [], now: provider.now() });
    expect(await rows()).toHaveLength(3);
    expect(await findDeviceCode({ database }, created.deviceCode)).not.toBeNull();
  });

  it('keeps an exchanged device code row while its tokens can be valid or its replay can revoke a live grant, then prunes it', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    await provider.decide(device.user_code, 'approve');
    const tokens = await (await provider.poll(device.device_code)).json() as { refresh_token: string };

    provider.advance(OAUTH_REFRESH_TOKEN_TTL_SECONDS - 1);
    await provider.start();
    expect(await provider.row(device.device_code)).not.toBeNull();
    const refreshed = await provider.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLI.clientId });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { access_token: string };

    // Its own tokens have expired, but the grant is live: replaying it must still revoke.
    provider.advance(OAUTH_DEVICE_CODE_TTL_SECONDS + 2);
    await provider.start();
    expect(await provider.row(device.device_code)).not.toBeNull();
    expect((await provider.introspect(rotated.access_token)).body).toMatchObject({ active: true });
    expect(await provider.pollError(device.device_code)).toBe('invalid_grant');
    expect((await provider.introspect(rotated.access_token)).body).toEqual({ active: false });

    // With the grant revoked, the row goes at its next due prune.
    provider.advance(OAUTH_REFRESH_TOKEN_TTL_SECONDS + OAUTH_DEVICE_CODE_TTL_SECONDS + 1);
    await provider.start();
    expect(await provider.row(device.device_code)).toBeNull();

    // An abandoned login, never refreshed or disconnected, goes once its refresh token expired.
    const abandoned = await provider.start();
    await provider.decide(abandoned.user_code, 'approve');
    expect((await provider.poll(abandoned.device_code)).status).toBe(200);
    provider.advance(OAUTH_REFRESH_TOKEN_TTL_SECONDS + OAUTH_DEVICE_CODE_TTL_SECONDS + 1);
    await provider.start();
    expect(await provider.row(abandoned.device_code)).toBeNull();
  });

  it('bounds the anonymous device authorization body in size and time before authenticating or counting it', async () => {
    const provider = await setupDevice({ device: { authorizationRateLimit: { global: 1 } } });
    await provider.start();
    expect((await provider.requestDeviceCode()).status).toBe(429);
    const rows = () => provider.database.findMany({ model: DEVICE_CODES, namespace: 'authfn' });
    const send = (body: BodyInit, headers: Record<string, string> = {}) => provider.handle('/auth/oauth/device_authorization', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
      duplex: 'half'
    } as RequestInit);
    const cancelled: string[] = [];
    const stream = (name: string, chunks: string[], end: boolean) => new ReadableStream<Uint8Array>({
      start: (controller) => {
        chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)));
        if (end) {
          controller.close();
        }
      },
      cancel: () => {
        cancelled.push(name);
      }
    });
    const form = `client_id=${CLI.clientId}&resource=${encodeURIComponent(MEMOTRON)}&scope=`;

    // A declared length over the limit is refused without waiting for the body.
    const declaredAt = Date.now();
    const declared = await send(stream('declared', [form], false), { 'content-length': String(64 * 1024) });
    expect(Date.now() - declaredAt).toBeLessThan(1000);
    const oversized = await send(`${form}${'x'.repeat(8 * 1024)}`);
    const chunked = await send(stream('chunked', [form, 'x'.repeat(4096), 'x'.repeat(4096)], false));
    const started = Date.now();
    const stalled = await send(stream('stalled', [form], false));
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    for (const response of [declared, oversized, chunked, stalled]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect(cancelled.sort()).toEqual(['chunked', 'declared', 'stalled']);
    expect(await rows()).toHaveLength(1);
  }, 15_000);
});

describe('storage pause control (test harness)', () => {
  const find = (database: ReturnType<typeof createInsertControl>['database'], id: string) =>
    database.findOne({ model: 'm', where: [{ field: 'id', operator: 'eq', value: id }] });
  const pausedOrDone = (reached: Promise<void>, call: Promise<unknown>) =>
    Promise.race([reached.then(() => 'paused'), call.then(() => 'done')]);
  const settled = async (call: Promise<unknown>) => {
    let done = false;
    void call.then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return done;
  };

  it('a pause released before any call reached it no longer pauses, and the next armed pause catches the next call', async () => {
    const control = createInsertControl(memoryAdapter({ debug: false }));
    void control.arm('m', 'findOne');
    control.release();
    const reached = control.arm('m', 'findOne');
    const call = find(control.database, 'x');
    expect(await pausedOrDone(reached, call)).toBe('paused');
    expect(await settled(call)).toBe(false);
    control.release();
    expect(await call).toBeNull();
  });

  it('releases overlapping reached and unreached pauses in arm order', async () => {
    const control = createInsertControl(memoryAdapter({ debug: false }));
    const matches = (id: string) => ({ where }: { where?: { field: string; value?: unknown }[] }) => where?.[0]?.value === id;
    void control.arm('m', 'findOne', matches('a'));
    const reachedB = control.arm('m', 'findOne', matches('b'));
    const callB = find(control.database, 'b');
    await reachedB;
    // The first release is A's, armed first though not reached: B stays paused, and A no longer pauses.
    control.release();
    expect(await settled(callB)).toBe(false);
    expect(await find(control.database, 'a')).toBeNull();
    control.release();
    expect(await callB).toBeNull();
  });
});
