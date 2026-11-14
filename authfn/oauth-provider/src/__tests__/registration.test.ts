import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { OAuthClientRegistrationConfig, OAuthProviderClient } from '../index.js';
import { ORIGIN, RFC7636_VERIFIER, setupProvider } from './harness.js';

type Provider = Awaited<ReturnType<typeof setupProvider>>;

const DOCUMENT_URL = 'https://mcp.example.com/oauth/client.json';
const DOCUMENT_CLIENT: OAuthProviderClient = { clientId: DOCUMENT_URL, name: '', redirectUris: ['https://mcp.example.com/cb'] };

function documentFor(overrides: Record<string, unknown> = {}) {
  return {
    client_id: DOCUMENT_URL,
    client_name: 'Example MCP Host',
    redirect_uris: ['https://mcp.example.com/cb', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    ...overrides
  };
}

/** A fetch that serves `documents` by URL (404 otherwise) and records each call. */
function documentFetch(documents: Record<string, unknown | (() => Response)>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const document = documents[url];
    if (typeof document === 'function') {
      return (document as () => Response)();
    }
    return document === undefined ? new Response('not found', { status: 404 }) : Response.json(document);
  }) as typeof fetch;
  return { impl, calls };
}

/**
 * A real HTTP server on 127.0.0.1 standing in for the document host; the
 * returned fetch is the platform fetch with the URL's origin rewritten to it,
 * so timeouts, size caps and cancellation run against a real socket.
 */
async function documentServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const closed: Promise<void>[] = [];
  const server = createServer((request, response) => {
    closed.push(new Promise((resolve) => request.socket.once('close', () => resolve())));
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const impl = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init)) as typeof fetch;
  return {
    impl,
    /** Resolves once the provider has closed the connection it opened. */
    connectionClosed: () => closed[0],
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

function publicExchange(provider: Provider, client: OAuthProviderClient, code: string, redirectUri = client.redirectUris[0]) {
  return provider.token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: RFC7636_VERIFIER,
    client_id: client.clientId
  });
}

async function registeredClients(provider: Provider): Promise<number> {
  return (await provider.database.findMany({ model: 'oauth_provider_clients', namespace: 'authfn' })).length;
}

async function metadata(provider: Provider): Promise<Record<string, unknown>> {
  return (await provider.handle('/auth/.well-known/oauth-authorization-server')).json() as Promise<Record<string, unknown>>;
}

/** The authorization request is refused directly: no redirect, no consent page. */
async function expectRefusedClient(provider: Provider, response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  expect(provider.consents).toHaveLength(0);
}

const byIp: OAuthClientRegistrationConfig['resolveClientIp'] = (request) => request.headers.get('x-test-ip');

describe('dynamic client registration (RFC 7591)', () => {
  it('is off unless configured: no endpoint, nothing advertised, URL client_ids unknown', async () => {
    const documents = documentFetch({ [DOCUMENT_URL]: documentFor() });
    const provider = await setupProvider({ registration: { fetch: documents.impl } });
    expect((await provider.register({ redirect_uris: ['https://host.example.com/cb'] })).status).not.toBe(201);
    expect(await registeredClients(provider)).toBe(0);
    const advertised = await metadata(provider);
    expect(advertised).not.toHaveProperty('registration_endpoint');
    expect(advertised).not.toHaveProperty('client_id_metadata_document_supported');
    await expectRefusedClient(provider, await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT)));
    expect(documents.calls).toEqual([]);
  });

  it('registers a public MCP host that authorizes on any loopback port and redeems its code without a secret', async () => {
    const provider = await setupProvider({ registration: { dynamic: true } });
    expect(await metadata(provider)).toMatchObject({ registration_endpoint: `${ORIGIN}/auth/oauth/register` });

    const response = await provider.register({
      client_name: 'Example MCP Host',
      redirect_uris: ['http://127.0.0.1:33418/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      logo_uri: 'https://host.example.com/logo.png'
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const registered = await response.json() as Record<string, unknown>;
    expect(registered).toEqual({
      client_id: expect.stringMatching(/^ocd_[0-9a-f]{24}$/),
      client_id_issued_at: Math.floor(provider.now().getTime() / 1000),
      client_name: 'Example MCP Host',
      redirect_uris: ['http://127.0.0.1:33418/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    });

    const client = { clientId: registered.client_id as string, name: '', redirectUris: ['http://127.0.0.1:50123/callback'] };
    const callback = await provider.authorize({}, client);
    // A self-registered client is never trusted: the user is asked.
    expect(provider.consents[0].client).toEqual({ clientId: client.clientId, name: 'Example MCP Host', trusted: false });
    expect(`${callback.origin}${callback.pathname}`).toBe('http://127.0.0.1:50123/callback');

    const exchanged = await publicExchange(provider, client, callback.searchParams.get('code')!);
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json() as { refresh_token: string };
    const refreshed = await provider.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.clientId });
    expect(refreshed.status).toBe(200);
  });

  it('accepts only public clients and well-formed metadata, storing nothing otherwise', async () => {
    const provider = await setupProvider({ registration: { dynamic: true } });
    const redirect_uris = ['https://host.example.com/cb'];
    for (const metadata of [
      { redirect_uris, token_endpoint_auth_method: 'client_secret_basic' },
      { redirect_uris, token_endpoint_auth_method: 'client_secret_post' },
      { redirect_uris, client_secret: 'chosen-by-the-client' },
      { redirect_uris, grant_types: ['client_credentials'] },
      { redirect_uris, grant_types: ['refresh_token'] },
      { redirect_uris, response_types: ['token'] },
      { redirect_uris, client_name: 'Host\u0007' },
      [redirect_uris]
    ]) {
      const response = await provider.register(metadata);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' });
    }
    const oversized = await provider.register({ redirect_uris, client_name: 'x', padding: 'x'.repeat(64 * 1024) });
    expect(await oversized.json()).toMatchObject({ error: 'invalid_client_metadata' });
    const notJson = await provider.handle('/auth/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'redirect_uris=https://host.example.com/cb'
    });
    expect(await notJson.json()).toMatchObject({ error: 'invalid_client_metadata' });
    expect(await registeredClients(provider)).toBe(0);
  });
});

describe('client ID metadata documents', () => {
  it('resolves an https client_id from its document, reuses it for 5 minutes, and the host completes the flow', async () => {
    const documents = documentFetch({ [DOCUMENT_URL]: documentFor() });
    const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: documents.impl } });
    expect(await metadata(provider)).toMatchObject({ client_id_metadata_document_supported: true });

    const callback = await provider.authorize({}, DOCUMENT_CLIENT);
    expect(provider.consents[0].client).toEqual({ clientId: DOCUMENT_URL, name: 'Example MCP Host', trusted: false });
    const exchanged = await publicExchange(provider, DOCUMENT_CLIENT, callback.searchParams.get('code')!);
    expect(exchanged.status).toBe(200);
    // Authorization request, consent decision and token exchange: one fetch.
    expect(documents.calls).toEqual([DOCUMENT_URL]);

    // After 5 minutes it is fetched again, once for concurrent requests.
    provider.advance(5 * 60 + 1);
    const requests = await Promise.all([1, 2, 3].map(() => provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT))));
    expect(requests.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(documents.calls).toEqual([DOCUMENT_URL, DOCUMENT_URL]);
  });

  it('refuses a client_id URL that is not a public https document, without fetching it', async () => {
    const documents = documentFetch({});
    const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: documents.impl } });
    for (const clientId of [
      'http://mcp.example.com/client.json',
      'https://127.0.0.1/client.json',
      'https://2130706433/client.json',
      'https://[::1]/client.json',
      'https://localhost/client.json',
      'https://metadata.google.internal/client.json',
      'https://intranet/client.json',
      'https://mcp.example.com/',
      'https://mcp.example.com/client.json?v=1',
      'https://mcp.example.com/a/../client.json',
      'https://user:pass@mcp.example.com/client.json',
      'https://MCP.example.com/client.json',
      'https://mcp.example.com:443/client.json',
      `https://mcp.example.com/${'a'.repeat(250)}`
    ]) {
      const client = { clientId, name: '', redirectUris: ['https://mcp.example.com/cb'] };
      await expectRefusedClient(provider, await provider.getAuthorize(provider.authorizeQuery({}, client)));
    }
    expect(documents.calls).toEqual([]);
  });

  it('keeps a known client on its last document while its host is unavailable, and drops it once the host answers without one', async () => {
    let serve: () => Response = () => Response.json(documentFor());
    const documents = documentFetch({ [DOCUMENT_URL]: () => serve() });
    const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: documents.impl } });
    const query = provider.authorizeQuery({}, DOCUMENT_CLIENT);
    expect((await provider.getAuthorize(query)).status).toBe(200);

    for (const unavailable of [
      () => new Response('down', { status: 503 }),
      () => new Response('slow down', { status: 429 }),
      () => { throw new TypeError('fetch failed'); }
    ]) {
      serve = unavailable;
      provider.advance(5 * 60 + 1);
      expect((await provider.getAuthorize(query)).status).toBe(200);
    }
    expect(documents.calls).toHaveLength(4);

    // A definitive answer that is not a document (here not found, or a body
    // that is not UTF-8) ends the client, also for later outages, until it
    // serves a document again.
    for (const definitive of [
      () => new Response('not found', { status: 404 }),
      () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { 'content-type': 'application/json' } })
    ]) {
      serve = definitive;
      provider.advance(5 * 60 + 1);
      expect((await provider.getAuthorize(query)).status).toBe(400);
      serve = () => new Response('down', { status: 503 });
      expect((await provider.getAuthorize(query)).status).toBe(400);
      serve = () => Response.json(documentFor());
      expect((await provider.getAuthorize(query)).status).toBe(200);
    }
    expect(documents.calls).toHaveLength(10);
  });

  it('refuses a document that names another client, carries a secret, redirects or is not a JSON 200', async () => {
    for (const served of [
      documentFor({ client_id: 'https://other.example.com/client.json' }),
      documentFor({ client_secret: 'secret' }),
      documentFor({ token_endpoint_auth_method: 'client_secret_basic' }),
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/client.json' } }),
      () => new Response('{', { status: 200 }),
      () => Response.json(documentFor(), { status: 201 })
    ]) {
      const documents = documentFetch({ [DOCUMENT_URL]: served });
      const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: documents.impl } });
      await expectRefusedClient(provider, await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT)));
      expect(documents.calls).toEqual([DOCUMENT_URL]);
    }
  });
});

describe('in-scope actors (AUTH-8)', () => {
  it('redirect-URI mismatch: only https and 127.0.0.1 loopback register, and an unregistered redirect is never used', async () => {
    const documents = documentFetch({ [DOCUMENT_URL]: documentFor() });
    const provider = await setupProvider({ registration: { dynamic: true, metadataDocuments: true, fetch: documents.impl } });
    for (const redirectUri of [
      'http://localhost:3000/callback',
      'http://[::1]:3000/callback',
      'http://host.example.com/callback',
      'com.example.app:/callback',
      'https://host.example.com/callback#fragment',
      'https://host.example.com/callback?code=injected',
      'javascript:alert(1)'
    ]) {
      const response = await provider.register({ redirect_uris: [redirectUri] });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
    const tooMany = Array.from({ length: 11 }, (_, index) => `https://host.example.com/cb${index}`);
    expect(await (await provider.register({ redirect_uris: tooMany })).json()).toMatchObject({ error: 'invalid_redirect_uri' });
    const unsafeDocument = documentFetch({ [DOCUMENT_URL]: documentFor({ redirect_uris: ['http://localhost/callback'] }) });
    const unsafe = await setupProvider({ registration: { metadataDocuments: true, fetch: unsafeDocument.impl } });
    await expectRefusedClient(unsafe, await unsafe.getAuthorize(unsafe.authorizeQuery({}, DOCUMENT_CLIENT)));

    const registered = await (await provider.register({ redirect_uris: ['https://host.example.com/callback'] })).json() as { client_id: string };
    for (const [clientId, redirectUri] of [
      [registered.client_id, 'https://evil.example.com/callback'],
      [registered.client_id, 'https://host.example.com/callback/other'],
      [registered.client_id, 'https://host.example.com:8443/callback'],
      [registered.client_id, 'http://127.0.0.1/callback'],
      [DOCUMENT_URL, 'https://evil.example.com/cb'],
      [DOCUMENT_URL, 'http://127.0.0.1/callback/other']
    ]) {
      const client = { clientId, name: '', redirectUris: [redirectUri] };
      await expectRefusedClient(provider, await provider.getAuthorize(provider.authorizeQuery({}, client)));
    }
  });

  it('oversized metadata document: a declared length over 64 KB is refused at once, a streamed one is cut off', async () => {
    const declared = await documentServer((_, response) => {
      // Promises more than the cap and then stalls: the headers alone decide.
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) });
      response.write('{');
    });
    const streamed = await documentServer((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const chunk = `{"client_name":"${'x'.repeat(16 * 1024)}`;
      const pump = () => {
        while (!response.destroyed && response.write(chunk)) { /* fill until backpressure */ }
        if (!response.destroyed) {
          response.once('drain', pump);
        }
      };
      pump();
    });
    try {
      for (const server of [declared, streamed]) {
        const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: server.impl } });
        const started = Date.now();
        await expectRefusedClient(provider, await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT)));
        expect(Date.now() - started).toBeLessThan(2000);
        await server.connectionClosed();
      }
    } finally {
      await declared.close();
      await streamed.close();
    }

    // The cap is 64 KB of body: exactly that is accepted, one byte more is not.
    const exact = JSON.stringify(documentFor()).padEnd(64 * 1024, ' ');
    for (const [body, accepted] of [[exact, true], [`${exact} `, false]] as const) {
      const documents = documentFetch({ [DOCUMENT_URL]: () => new Response(body) });
      const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: documents.impl } });
      const response = await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT));
      expect(response.status).toBe(accepted ? 200 : 400);
    }
  });

  it('slow metadata document: one still streaming after 5 seconds is refused and its connection closed', async () => {
    const slow = await documentServer((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      const drip = setInterval(() => response.write(' '), 250);
      response.once('close', () => clearInterval(drip));
    });
    try {
      const provider = await setupProvider({ registration: { metadataDocuments: true, fetch: slow.impl } });
      const started = Date.now();
      await expectRefusedClient(provider, await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT)));
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4900);
      expect(elapsed).toBeLessThan(7000);
      await slow.connectionClosed();
    } finally {
      await slow.close();
    }
  }, 15_000);

  it('registration flooding: limited per IP and overall per window, refusals store nothing', async () => {
    const provider = await setupProvider({
      registration: { dynamic: true, rateLimit: { perIp: 3, global: 5, windowSeconds: 60 }, resolveClientIp: byIp }
    });
    const metadata = { redirect_uris: ['https://host.example.com/cb'] };
    const statuses = async (ip: string, count: number) => {
      const results: number[] = [];
      for (let index = 0; index < count; index += 1) {
        results.push((await provider.register(metadata, ip)).status);
      }
      return results;
    };
    expect(await statuses('203.0.113.1', 4)).toEqual([201, 201, 201, 429]);
    const refused = await provider.register(metadata, '203.0.113.1');
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toMatchObject({ error: 'temporarily_unavailable' });
    // Another IP is admitted until the global limit.
    expect(await statuses('203.0.113.2', 3)).toEqual([201, 201, 429]);
    expect(await registeredClients(provider)).toBe(5);

    provider.advance(60);
    expect(await statuses('203.0.113.1', 1)).toEqual([201]);
  });

  it('registration flooding: a concurrent burst never registers more than the limit, and refusals free their place (SQL)', async () => {
    const provider = await setupProvider({ sql: true, registration: { dynamic: true, rateLimit: { global: 5 } } });
    const metadata = { redirect_uris: ['https://host.example.com/cb'] };
    const statuses = await Promise.all(Array.from({ length: 12 }, () => provider.register(metadata).then((r) => r.status)));
    const admitted = statuses.filter((status) => status === 201).length;
    expect(statuses.every((status) => status === 201 || status === 429)).toBe(true);
    expect(admitted).toBeLessThanOrEqual(5);
    expect(await registeredClients(provider)).toBe(admitted);
    // Refused attempts free their place: the window fills to exactly the limit.
    const later: number[] = [];
    for (let index = admitted; index <= 5; index += 1) {
      later.push((await provider.register(metadata)).status);
    }
    expect(later).toEqual([...Array(5 - admitted).fill(201), 429]);
    expect(await registeredClients(provider)).toBe(5);
  });

  it('registration flooding: older windows are pruned, never a newer one a lagging request runs behind', async () => {
    for (const sql of [false, true]) {
      const provider = await setupProvider({ sql, registration: { dynamic: true, rateLimit: { global: 2, windowSeconds: 60 } } });
      const metadata = { redirect_uris: ['https://host.example.com/cb'] };
      const status = async () => (await provider.register(metadata)).status;
      expect([await status(), await status(), await status()]).toEqual([201, 201, 429]);
      // A request whose clock is two windows behind is admitted into its own window...
      provider.advance(-120);
      expect(await status()).toBe(201);
      // ...and the full current window still refuses.
      provider.advance(120);
      expect(await status()).toBe(429);
      // Three windows on, every earlier window is pruned.
      provider.advance(180);
      expect(await status()).toBe(201);
      const events = await provider.database.findMany({ model: 'oauth_provider_registration_events', namespace: 'authfn' });
      expect(events).toHaveLength(1);
    }
  });

  it.each([false, true])('registration flooding: the document window limits only new clients; known ones are refetched outside it (sql: %s)', async (sql) => {
    const others = [1, 2].map((index) => `https://mcp${index}.example.com/client.json`);
    let current = documentFor();
    const documents = documentFetch({
      [DOCUMENT_URL]: () => Response.json(current),
      ...Object.fromEntries(others.map((url) => [url, documentFor({ client_id: url })]))
    });
    const provider = await setupProvider({ sql, registration: { metadataDocuments: true, fetch: documents.impl, rateLimit: { global: 2 } } });
    const callback = await provider.authorize({}, DOCUMENT_CLIENT);
    const exchanged = await publicExchange(provider, DOCUMENT_CLIENT, callback.searchParams.get('code')!);
    const { refresh_token: refreshToken } = await exchanged.json() as { refresh_token: string };
    const authorizeNew = async (clientId: string) => (await provider.getAuthorize(
      provider.authorizeQuery({ redirect_uri: 'https://mcp.example.com/cb' }, { ...DOCUMENT_CLIENT, clientId }), false)).status;

    // A known client refetched every 5 minutes does not use up the window...
    for (let round = 0; round < 4; round += 1) {
      provider.advance(5 * 60 + 1);
      expect((await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT))).status).toBe(200);
    }
    expect(documents.calls).toEqual(Array(5).fill(DOCUMENT_URL));
    // ...so a new client is still admitted, and the next one fills it.
    expect([await authorizeNew(others[0]), await authorizeNew(others[1])]).toEqual([401, 429]);

    // In the full window, the known client picks up its changed document and
    // still refreshes, authorizes and revokes, with one fetch for all three.
    current = documentFor({ redirect_uris: ['https://mcp.example.com/moved'] });
    provider.advance(5 * 60 + 1);
    const refreshed = await provider.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: DOCUMENT_URL });
    expect(refreshed.status).toBe(200);
    const moved = { ...DOCUMENT_CLIENT, redirectUris: ['https://mcp.example.com/moved'] };
    expect((await provider.getAuthorize(provider.authorizeQuery({}, moved))).status).toBe(200);
    const removed = await provider.getAuthorize(provider.authorizeQuery({}, DOCUMENT_CLIENT));
    expect([removed.status, removed.headers.get('location')]).toEqual([400, null]);
    const { refresh_token: rotated } = await refreshed.json() as { refresh_token: string };
    const revoked = await provider.handle('/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rotated, client_id: DOCUMENT_URL })
    });
    expect(revoked.status).toBe(200);
    expect(await authorizeNew(others[1])).toBe(429);
    expect(documents.calls).toEqual([...Array(5).fill(DOCUMENT_URL), others[0], DOCUMENT_URL]);
  });

  it.each([false, true])('registration flooding: a known client is refetched at most once per 5 minutes across instances (sql: %s)', async (sql) => {
    const documents = documentFetch({ [DOCUMENT_URL]: documentFor() });
    const provider = await setupProvider({ sql, registration: { metadataDocuments: true, fetch: documents.impl } });
    const instances = [provider.handle, provider.instance(), provider.instance()];
    const query = provider.authorizeQuery({}, DOCUMENT_CLIENT);
    const authorizeEverywhere = async () => (await Promise.all(instances.map((handle) =>
      handle(`/auth/oauth/authorize?${query}`, { headers: { cookie: provider.cookie } })))).map((response) => response.status);

    expect((await provider.getAuthorize(query)).status).toBe(200);
    for (let round = 1; round <= 3; round += 1) {
      // Within 5 minutes of the last fetch, no instance refetches; after, exactly one does.
      provider.advance(4 * 60);
      expect(await authorizeEverywhere()).toEqual([200, 200, 200]);
      expect(documents.calls).toHaveLength(round);
      provider.advance(60 + 1);
      expect(await authorizeEverywhere()).toEqual([200, 200, 200]);
      expect(documents.calls).toHaveLength(round + 1);
    }
  });

  it('registration flooding: metadata document fetches count toward the limit', async () => {
    const urls = [1, 2, 3].map((index) => `https://mcp${index}.example.com/client.json`);
    const documents = documentFetch(Object.fromEntries(urls.map((url) => [url, documentFor({ client_id: url })])));
    const provider = await setupProvider({
      registration: { metadataDocuments: true, fetch: documents.impl, rateLimit: { perIp: 2 }, resolveClientIp: byIp }
    });
    const statuses: number[] = [];
    for (const clientId of urls) {
      const query = provider.authorizeQuery({ redirect_uri: 'https://mcp.example.com/cb' }, { ...DOCUMENT_CLIENT, clientId });
      const response = await provider.handle(`/auth/oauth/authorize?${query}`, { headers: { cookie: provider.cookie, 'x-test-ip': '203.0.113.9' } });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(documents.calls).toEqual(urls.slice(0, 2));
  });
});
