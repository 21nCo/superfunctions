import { describe, expect, it } from 'vitest';
import { issueSession } from 'authfn/core/sessions';
import { createUser } from 'authfn/core/users';
import {
  disconnectOAuthClient,
  OAUTH_DEVICE_CODE_GRANT_TYPE,
  verifyOAuthAccessToken,
  type OAuthProviderClient
} from '../index.js';
import { createDeviceSchema } from '../device/index.js';
import { createOAuthProviderSchema } from '../store.js';
import { MEMOTRON, ORIGIN, POINTRON, RFC6749_BASIC, RFC6749_CLIENT, createProviderApp, setupProvider } from './harness.js';

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

  return { ...provider, requestDeviceCode, start, openPage, decide, poll, pollError };
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

    // A device code is bound to its client.
    const device = await provider.start();
    await provider.decide(device.user_code, 'approve');
    const stolen = await provider.poll(device.device_code, 'mcp-host');
    await expectError(stolen, 400, 'invalid_grant');
    expect((await provider.poll(device.device_code)).status).toBe(200);
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

  it('an approval during which the app is disconnected issues no usable grant', async () => {
    const provider = await setupDevice();
    const device = await provider.start();
    const paused = provider.control.arm('oauth_provider_grants');
    const decision = provider.decide(device.user_code, 'approve');
    await paused;
    await disconnectOAuthClient({ database: provider.database }, { userId: provider.user.id, clientId: CLI.clientId, resource: MEMOTRON, now: provider.now });
    provider.control.release();
    const response = await decision;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'access_denied' });
    expect(await provider.pollError(device.device_code)).toBe('invalid_grant');
  });

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

    // Of concurrent polls only one is answered; the others are too fast.
    provider.advance(15);
    const results = await Promise.all([1, 2, 3].map(async () => (await (await provider.poll(device.device_code)).json() as { error: string }).error));
    expect(results.sort()).toEqual(['authorization_pending', 'slow_down', 'slow_down']);

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
