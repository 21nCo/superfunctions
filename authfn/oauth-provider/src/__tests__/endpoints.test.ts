import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/adapters/memory/index.js';
import { authfn } from 'authfn';
import { secretsEqual } from '../http.js';
import { authFnOAuthProviderPlugin } from '../index.js';
import { trimTrailingSlashes } from '../runtime.js';
import {
  MCP_HOST,
  MEMOTRON,
  MEMOTRON_SECRET,
  ORIGIN,
  POINTRON,
  RESOURCES,
  RFC6749_BASIC,
  RFC6749_CLIENT,
  RFC7636_VERIFIER,
  RHOMBUS,
  createProviderApp,
  setupProvider
} from './harness.js';

describe('metadata (RFC 8414)', () => {
  it('advertises PKCE S256 only, the code grant with refresh, and every endpoint', async () => {
    const provider = await setupProvider();
    const response = await provider.handle('/auth/.well-known/oauth-authorization-server');
    expect(await response.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/auth/oauth/authorize`,
      token_endpoint: `${ORIGIN}/auth/oauth/token`,
      revocation_endpoint: `${ORIGIN}/auth/oauth/revoke`,
      introspection_endpoint: `${ORIGIN}/auth/oauth/introspect`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['memotron:read', 'memotron:write', 'pointron:read', 'pointron:write'],
      authorization_response_iss_parameter_supported: true
    });
  });
});

describe('authorization endpoint', () => {
  it('never redirects to an unverified client or redirect URI (RFC 6749 4.1.2.1, 3.1)', async () => {
    const provider = await setupProvider();
    const cases = [
      provider.authorizeQuery({ client_id: 'unknown' }),
      provider.authorizeQuery({ redirect_uri: 'https://attacker.example.com/cb' }),
      provider.authorizeQuery({ redirect_uri: undefined }),
      new URLSearchParams(`${provider.authorizeQuery()}&redirect_uri=https%3A%2F%2Fattacker.example.com%2Fcb`)
    ];
    for (const query of cases) {
      const response = await provider.getAuthorize(query);
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect(provider.consents).toHaveLength(0);
  });

  it('returns other request errors to the client with state and iss (RFC 6749 4.1.2.1, RFC 9207)', async () => {
    const provider = await setupProvider();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ scope: 'memotron:admin' }, 'invalid_scope'],
      [{ scope: 'pointron:read' }, 'invalid_scope']
    ];
    for (const [overrides, error] of cases) {
      const location = new URL((await provider.getAuthorize(provider.authorizeQuery(overrides))).headers.get('location')!);
      expect(location.origin + location.pathname).toBe('https://client.example.com/cb');
      expect(Object.fromEntries(location.searchParams)).toMatchObject({ error, state: 'xyz', iss: ORIGIN });
    }
  });

  it('hands an unauthenticated request to the login hook with a return URL', async () => {
    const provider = await setupProvider();
    const query = provider.authorizeQuery();
    const response = await provider.getAuthorize(query, false);
    expect(response.status).toBe(401);
    expect(provider.logins[0].returnTo).toBe(`${ORIGIN}/auth/oauth/authorize?${query}`);
  });

  it('records a denial as access_denied and requires the CSRF token for a decision', async () => {
    const provider = await setupProvider();
    await provider.getAuthorize(provider.authorizeQuery());
    const params = { ...provider.consents[0].params };

    const forged = await provider.decide(params, 'approve', 'wrong-csrf');
    expect(forged.status).toBe(403);

    const denied = await provider.decide(params, 'deny');
    const location = new URL((await denied.json() as { data: { redirectTo: string } }).data.redirectTo);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.has('code')).toBe(false);

    // A tampered decision is validated again like the original request.
    const tampered = await provider.decide({ ...params, redirect_uri: 'https://attacker.example.com/cb' }, 'approve');
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ error: 'invalid_request' });

    // A decision body that is valid JSON but not an object is a client error.
    for (const body of ['null', '[]', '"approve"', '42']) {
      const response = await provider.handle('/auth/oauth/authorize', {
        method: 'POST',
        headers: { cookie: provider.cookie, 'content-type': 'application/json', 'x-authfn-csrf': provider.session.csrfToken },
        body
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
    // Malformed JSON gets the same OAuth error, not the AuthFn envelope.
    const malformed = await provider.handle('/auth/oauth/authorize', {
      method: 'POST',
      headers: { cookie: provider.cookie, 'content-type': 'application/json', 'x-authfn-csrf': provider.session.csrfToken },
      body: '{"decision":'
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_request', error_description: 'The decision body must be valid JSON' });
  });

  it('sends the response to the registered redirect URI byte for byte, then the parameters (RFC 6749 3.1.2)', async () => {
    // Reserializing this query would rewrite it as ?flag=&v=a+b&p=x%2Fy%3Bz.
    const registered = 'https://tenant.example.com/cb?flag&v=a%20b&p=x/y;z';
    const tenant = {
      clientId: 'tenant-app',
      name: 'Tenant App',
      redirectUris: [registered, 'https://tenant.example.com/open?', 'https://tenant.example.com/plain', 'https://tenant.example.com/next?to=?']
    };
    const provider = await setupProvider({ clients: [tenant] });
    const query = (redirectUri: string, overrides: Record<string, string> = {}) =>
      provider.authorizeQuery({ client_id: tenant.clientId, redirect_uri: redirectUri, ...overrides }, tenant);
    const iss = `&iss=${encodeURIComponent(ORIGIN)}`;

    expect((await provider.getAuthorize(query(registered))).status).toBe(200);
    const approved = await provider.decide({ ...provider.consents[0].params }, 'approve');
    const success = (await approved.json() as { data: { redirectTo: string } }).data.redirectTo;
    expect(success).toMatch(new RegExp(`^${registered.replaceAll(/[.?/;%]/g, '\\$&')}&code=[^&]+&state=xyz${iss}$`));
    const exchanged = await provider.token({
      grant_type: 'authorization_code',
      client_id: tenant.clientId,
      code: new URL(success).searchParams.get('code')!,
      redirect_uri: registered,
      code_verifier: RFC7636_VERIFIER
    });
    expect(exchanged.status).toBe(200);

    const denied = await provider.decide({ ...provider.consents[0].params }, 'deny');
    expect((await denied.json() as { data: { redirectTo: string } }).data.redirectTo.startsWith(`${registered}&error=access_denied&`)).toBe(true);
    const invalid = await provider.getAuthorize(query(registered, { scope: 'memotron:admin' }));
    expect(invalid.headers.get('location')!.startsWith(`${registered}&error=invalid_scope&`)).toBe(true);
    const open = await provider.getAuthorize(query('https://tenant.example.com/open?', { scope: 'memotron:admin' }));
    expect(open.headers.get('location')!.startsWith('https://tenant.example.com/open?error=invalid_scope&')).toBe(true);
    const plain = await provider.getAuthorize(query('https://tenant.example.com/plain', { scope: 'memotron:admin' }));
    expect(plain.headers.get('location')!.startsWith('https://tenant.example.com/plain?error=invalid_scope&')).toBe(true);
    // A query value ending in '?' is not an empty query.
    const next = await provider.getAuthorize(query('https://tenant.example.com/next?to=?', { scope: 'memotron:admin' }));
    const nextLocation = next.headers.get('location')!;
    expect(nextLocation.startsWith('https://tenant.example.com/next?to=?&error=invalid_scope&')).toBe(true);
    expect(new URL(nextLocation).searchParams.get('error')).toBe('invalid_scope');

    // The URL parser drops a tab, so a loopback URI with one would match on
    // any port; the raw value must still be header-safe.
    const tabbed = await provider.getAuthorize(provider.authorizeQuery({ redirect_uri: 'http://127.0.0.1:8080/call\tback' }, MCP_HOST));
    expect(tabbed.status).toBe(400);
    expect(tabbed.headers.get('location')).toBeNull();
  });

  it('redirects to a native app\'s reverse-domain scheme (RFC 8252 7.1)', async () => {
    const native = { clientId: 'native-app', name: 'Native App', redirectUris: ['com.example.app:/oauth/cb'] };
    const provider = await setupProvider({ clients: [native] });
    expect((await provider.getAuthorize(provider.authorizeQuery({ client_id: native.clientId, redirect_uri: native.redirectUris[0] }, native))).status).toBe(200);
    const approved = await provider.decide({ ...provider.consents[0].params }, 'approve');
    const location = (await approved.json() as { data: { redirectTo: string } }).data.redirectTo;
    expect(location).toMatch(new RegExp(`^com\\.example\\.app:/oauth/cb\\?code=[^&]+&state=xyz&iss=${encodeURIComponent(ORIGIN)}$`));
    const exchanged = await provider.token({
      grant_type: 'authorization_code',
      client_id: native.clientId,
      code: new URL(location).searchParams.get('code')!,
      redirect_uri: native.redirectUris[0],
      code_verifier: RFC7636_VERIFIER
    });
    expect(exchanged.status).toBe(200);
  });

  it('asks a trusted client for consent once per resource, and an untrusted client every time', async () => {
    const provider = await setupProvider();
    const rhombus = { redirect_uri: RHOMBUS.redirectUris[0], client_id: RHOMBUS.clientId, scope: 'memotron:read' };
    await provider.authorize(rhombus, RHOMBUS);
    expect(provider.consents).toHaveLength(1);
    expect(provider.consents[0].client).toEqual({ clientId: 'rhombus', name: 'Rhombus', trusted: true });

    const remembered = await provider.getAuthorize(provider.authorizeQuery(rhombus, RHOMBUS));
    expect(remembered.status).toBe(302);
    expect(new URL(remembered.headers.get('location')!).searchParams.get('code')).toEqual(expect.any(String));

    await provider.getAuthorize(provider.authorizeQuery({ ...rhombus, scope: 'memotron:read memotron:write' }, RHOMBUS));
    await provider.getAuthorize(provider.authorizeQuery({ ...rhombus, resource: POINTRON, scope: 'pointron:read' }, RHOMBUS));
    expect(provider.consents).toHaveLength(3);

    await provider.authorize();
    await provider.getAuthorize(provider.authorizeQuery());
    expect(provider.consents).toHaveLength(5);
  });

  it('accepts a loopback redirect on any port (RFC 8252 7.3)', async () => {
    const provider = await setupProvider();
    const callback = await provider.authorize({ redirect_uri: 'http://127.0.0.1:53682/callback' }, MCP_HOST);
    expect(callback.port).toBe('53682');

    const response = await provider.token({
      grant_type: 'authorization_code',
      client_id: MCP_HOST.clientId,
      code: callback.searchParams.get('code')!,
      redirect_uri: 'http://127.0.0.1:53682/callback',
      code_verifier: RFC7636_VERIFIER
    });
    expect(response.status).toBe(200);

    const otherPath = await provider.getAuthorize(provider.authorizeQuery({ redirect_uri: 'http://127.0.0.1:53682/other' }, MCP_HOST));
    expect(otherPath.status).toBe(400);
  });
});

describe('token endpoint', () => {
  it('authenticates clients and binds codes to the client and redirect URI (RFC 6749 2.3.1, 4.1.3)', async () => {
    const provider = await setupProvider();
    const code = (await provider.authorize()).searchParams.get('code')!;

    const wrongSecret = await provider.exchange(code, {}, { authorization: `Basic ${btoa('s6BhdRkqt3:nope')}` });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.headers.get('www-authenticate')).toContain('Basic');
    expect(await wrongSecret.json()).toMatchObject({ error: 'invalid_client' });

    // RFC 6749 5.2: 401 and a challenge only for an Authorization header attempt.
    const noSecret = await provider.exchange(code, { client_id: RFC6749_CLIENT.clientId }, {} as { authorization: string });
    const inBody = await provider.exchange(code, {
      client_id: RFC6749_CLIENT.clientId,
      client_secret: RFC6749_CLIENT.clientSecret!
    }, {} as { authorization: string });
    const noClient = await provider.token({ grant_type: 'authorization_code', code });
    for (const response of [noSecret, inBody, noClient]) {
      expect(response.status).toBe(400);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    }

    const otherClient = await provider.exchange(code, { client_id: MCP_HOST.clientId }, {} as { authorization: string });
    expect(await otherClient.json()).toMatchObject({ error: 'invalid_grant' });

    const otherRedirect = await provider.exchange(code, { redirect_uri: 'https://client.example.com/other' });
    expect(await otherRedirect.json()).toMatchObject({ error: 'invalid_grant' });

    const unsupported = await provider.token({ grant_type: 'password' }, { authorization: RFC6749_BASIC });
    expect(await unsupported.json()).toMatchObject({ error: 'unsupported_grant_type' });
    for (const form of [{}, { grant_type: '' }]) {
      const missing = await provider.token(form, { authorization: RFC6749_BASIC });
      expect(await missing.json()).toMatchObject({ error: 'invalid_request' });
    }

    const json = await provider.handle('/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code })
    });
    expect(await json.json()).toMatchObject({ error: 'invalid_request' });

    expect((await provider.exchange(code)).status).toBe(200);
  });

  it('refuses any Authorization header from a client not registered for Basic (RFC 6749 2.3)', async () => {
    const post = { clientId: 'post-client', name: 'Post', clientSecret: 'post-secret', tokenEndpointAuthMethod: 'client_secret_post' as const, redirectUris: ['https://post.example.com/cb'] };
    const provider = await setupProvider({ clients: [post] });
    const credentials = [{ client_id: MCP_HOST.clientId }, { client_id: post.clientId, client_secret: post.clientSecret }];
    for (const path of ['/auth/oauth/token', '/auth/oauth/revoke']) {
      const call = (form: Record<string, string>, headers: Record<string, string> = {}) => provider.handle(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'unknown', token: 'unknown', ...form })
      });
      for (const form of credentials) {
        // Without a header the client authenticates.
        expect((await call(form)).status).toBe(path === '/auth/oauth/token' ? 400 : 200);
        for (const authorization of ['Bearer abc', 'Basic', 'Basic !!!', 'garbage', RFC6749_BASIC]) {
          const response = await call(form, { authorization });
          expect(response.status).toBe(401);
          expect(response.headers.get('www-authenticate')).toContain('Basic');
          expect(await response.json()).toMatchObject({ error: 'invalid_client' });
        }
      }
    }
  });

  it('narrows a refresh to a subset of the granted scopes only', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();
    const wider = await provider.refresh(issued.refresh_token, { scope: 'memotron:read pointron:read' });
    expect(await wider.json()).toMatchObject({ error: 'invalid_scope' });

    const narrowed = await (await provider.refresh(issued.refresh_token, { scope: 'memotron:read' })).json() as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(narrowed.scope).toBe('memotron:read');
    expect((await provider.introspect(narrowed.access_token)).body.scope).toBe('memotron:read');
    expect(await (await provider.refresh(narrowed.refresh_token)).json()).toMatchObject({ scope: 'memotron:read memotron:write' });
  });

  it('stops honouring tokens of a user who was deleted or disabled', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();
    await provider.database.update({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: provider.user.id }],
      data: { metadata: { disabled: true } },
      namespace: 'authfn'
    });
    expect((await provider.introspect(issued.access_token)).body).toEqual({ active: false });
    expect(await (await provider.refresh(issued.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('introspection (RFC 7662)', () => {
  it('requires a resource server credential', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();
    const unauthenticated = await provider.introspect(issued.access_token, 'not-a-secret');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({ error: 'invalid_token' });
    expect((await provider.introspect(issued.refresh_token)).body).toEqual({ active: false });

    // RFC 6750 2.1: "Bearer", one or more spaces, then one b64token.
    const introspectWith = (authorization: string) => provider.handle('/auth/oauth/introspect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
      body: new URLSearchParams({ token: issued.access_token })
    });
    for (const header of [`Bearer ${MEMOTRON_SECRET} extra`, `Bearer ${MEMOTRON_SECRET},x`, `Bearer\t${MEMOTRON_SECRET}`]) {
      expect((await introspectWith(header)).status).toBe(401);
    }
    expect(await (await introspectWith(`bearer   ${MEMOTRON_SECRET}`)).json()).toMatchObject({ active: true });
  });
});

describe('revocation (RFC 7009)', () => {
  it('answers a failed client authentication like the token endpoint', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();
    const revoke = (headers: Record<string, string>, form: Record<string, string> = {}) => provider.handle('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ token: issued.access_token, ...form })
    });
    for (const authorization of [`Basic ${btoa(`${RFC6749_CLIENT.clientId}:nope`)}`, 'Basic']) {
      const basic = await revoke({ authorization }, { client_id: RFC6749_CLIENT.clientId });
      expect(basic.status).toBe(401);
      expect(basic.headers.get('www-authenticate')).toContain('Basic');
    }
    for (const response of [await revoke({}), await revoke({}, { client_id: RFC6749_CLIENT.clientId, client_secret: 'nope' })]) {
      expect(response.status).toBe(400);
      expect(response.headers.get('www-authenticate')).toBeNull();
    }
    expect((await provider.introspect(issued.access_token)).body.active).toBe(true);
  });
});

describe('helpers', () => {
  it('trims trailing slashes in linear time and compares secrets of any length', () => {
    expect(trimTrailingSlashes('https://auth.example.com///')).toBe('https://auth.example.com');
    const slashes = `https://auth.example.com${'/'.repeat(100_000)}x`;
    expect(trimTrailingSlashes(slashes)).toBe(slashes);
    expect(trimTrailingSlashes('')).toBe('');
    expect(secretsEqual('secret', 'secret')).toBe(true);
    expect(secretsEqual('secret', 'secret2')).toBe(false);
    expect(secretsEqual('secreT', 'secret')).toBe(false);
  });
});

describe('configuration', () => {
  const hooks = { loginRequired: () => new Response(null), consent: () => new Response(null) };

  it('rejects a provider whose resources offer scopes outside the AuthFn registry', () => {
    const create = (resources: typeof RESOURCES) => createProviderApp().createServer({
      database: memoryAdapter({ debug: false }),
      pluginRuntime: { oauthProvider: { clients: [], resources, ...hooks } }
    });
    expect(() => create([{ resource: MEMOTRON, scopes: ['memotron:admin'] }]))
      .toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    expect(() => create([{ resource: 'not a uri', scopes: ['memotron:read'] }]))
      .toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    expect(() => create(RESOURCES)).not.toThrow();
  });

  it('rejects an introspection secret shared by two resources', () => {
    const create = (resources: typeof RESOURCES) => createProviderApp().createServer({
      database: memoryAdapter({ debug: false }),
      pluginRuntime: { oauthProvider: { clients: [], resources, ...hooks } }
    });
    const shared = RESOURCES.map((resource) => ({ ...resource, introspectionSecret: 'shared-secret' }));
    expect(() => create(shared)).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    const empty = [{ ...RESOURCES[0], introspectionSecret: '' }];
    expect(() => create(empty)).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    expect(() => create([RESOURCES[0], { ...RESOURCES[1], introspectionSecret: undefined }])).not.toThrow();
  });

  it('accepts only redirect URIs that keep the response off plaintext networks and free of collisions', () => {
    const create = (redirectUris: string[]) => createProviderApp().createServer({
      database: memoryAdapter({ debug: false }),
      pluginRuntime: { oauthProvider: { clients: [{ clientId: 'c', name: 'C', redirectUris }], resources: RESOURCES, ...hooks } }
    });
    for (const uri of [
      'http://client.example.com/cb',
      'http://localhost:8080/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///tmp/cb',
      'vbscript:x',
      'blob:https://a.example/x',
      'about:blank',
      'ftp://a.example/cb',
      'ws://a.example/cb',
      'wss://a.example/cb',
      'myapp:/cb',
      'https://例え.example/cb',
      'https://client.example.com/cb?tenant=日本語',
      'https://client.example.com/c b',
      'https://client.example.com/cb?x=1\n',
      'https://client.example.com/cb?state=fixed',
      'https://client.example.com/cb?code=1',
      'https://client.example.com/cb?iss=x',
      'https://client.example.com/cb#frag'
    ]) {
      expect(() => create([uri])).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    }
    expect(() => create([
      'https://client.example.com/cb?tenant=a',
      'http://127.0.0.1/callback',
      'http://[::1]:8080/callback',
      'http://[::1]/callback',
      'http://127.0.0.1:8080/cb',
      'https://xn--r8jz45g.example/cb?tenant=%E6%97%A5',
      'com.example.app:/oauth/callback'
    ])).not.toThrow();
  });

  it('requires introspection secrets that are valid Bearer credentials (RFC 6750 2.1)', () => {
    const create = (introspectionSecret: string) => createProviderApp().createServer({
      database: memoryAdapter({ debug: false }),
      pluginRuntime: { oauthProvider: { clients: [], resources: [{ ...RESOURCES[0], introspectionSecret }], ...hooks } }
    });
    for (const secret of ['has space', 'comma,secret', 'pad=ding', 'unicode-é']) {
      expect(() => create(secret)).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    }
    expect(() => create('abc-._~+/XYZ019==')).not.toThrow();
  });

  it('declares its tables in the AuthFn schema', () => {
    const tables = authfn({ plugins: [authFnOAuthProviderPlugin()] }).getSchema().schemas.map((table) => table.modelName);
    expect(tables).toEqual(expect.arrayContaining([
      'oauth_provider_grants',
      'oauth_provider_codes',
      'oauth_provider_tokens',
      'oauth_provider_consents',
      'oauth_provider_disconnects'
    ]));
  });
});
