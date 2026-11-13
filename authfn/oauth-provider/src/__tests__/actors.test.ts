import { describe, expect, it } from 'vitest';
import { requireScopes } from 'authfn';
import { disconnectOAuthClient, revokeOAuthGrant, verifyOAuthAccessToken } from '../index.js';
import {
  MCP_HOST,
  MEMOTRON,
  ORIGIN,
  POINTRON,
  POINTRON_SECRET,
  RFC6749_CLIENT,
  RFC7636_CHALLENGE,
  RFC7636_VERIFIER,
  RHOMBUS,
  challengeFor,
  setupProvider
} from './harness.js';

describe('authorization code flow (RFC 6749 4.1, RFC 7636 Appendix B, RFC 8707 2)', () => {
  it('issues audience-bound, scoped tokens for the RFC example client, verifier and resource', async () => {
    const provider = await setupProvider();
    expect(challengeFor(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);

    const callback = await provider.authorize({ scope: 'memotron:read' });
    expect(`${callback.origin}${callback.pathname}`).toBe('https://client.example.com/cb');
    expect(callback.searchParams.get('state')).toBe('xyz');
    expect(callback.searchParams.get('iss')).toBe(ORIGIN);
    expect(provider.consents[0]).toMatchObject({
      user: { id: provider.user.id },
      client: { clientId: 's6BhdRkqt3', trusted: false },
      resource: MEMOTRON,
      scopes: ['memotron:read']
    });

    const response = await provider.exchange(callback.searchParams.get('code')!, { resource: MEMOTRON });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const tokens = await response.json() as Record<string, unknown>;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'memotron:read' });
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const introspection = await provider.introspect(tokens.access_token as string);
    expect(introspection.body).toMatchObject({
      active: true,
      aud: MEMOTRON,
      sub: provider.user.id,
      client_id: 's6BhdRkqt3',
      scope: 'memotron:read',
      iss: ORIGIN,
      token_type: 'Bearer'
    });
    expect((introspection.body.exp as number) - (introspection.body.iat as number)).toBe(3600);

    const info = await verifyOAuthAccessToken({ database: provider.database }, tokens.access_token as string, {
      resource: MEMOTRON,
      now: provider.now
    });
    expect(info).toMatchObject({ userId: provider.user.id, resource: MEMOTRON, scopes: ['memotron:read'] });
    expect(() => requireScopes(info, 'memotron:read')).not.toThrow();
    expect(() => requireScopes(info, 'memotron:write')).toThrow(expect.objectContaining({ code: 'AUTHFN_INSUFFICIENT_SCOPE' }));
  });
});

describe('in-scope actors', () => {
  it('code replay: a reused code is refused and revokes the tokens it already issued (RFC 6749 4.1.2, 10.5)', async () => {
    const provider = await setupProvider();
    const code = (await provider.authorize()).searchParams.get('code')!;
    const first = await (await provider.exchange(code)).json() as { access_token: string; refresh_token: string };

    // A party that holds the spent code but is not bound to it (wrong
    // verifier, another client, wrong redirect_uri) cannot revoke the grant.
    for (const attempt of [
      provider.exchange(code, { code_verifier: 'x'.repeat(43) }),
      provider.exchange(code, { redirect_uri: 'https://client.example.com/other' }),
      provider.token({
        grant_type: 'authorization_code',
        client_id: MCP_HOST.clientId,
        code,
        redirect_uri: RFC6749_CLIENT.redirectUris[0],
        code_verifier: RFC7636_VERIFIER
      })
    ]) {
      const response = await attempt;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    }
    expect((await provider.introspect(first.access_token)).body.active).toBe(true);

    // The client the code was issued to, replaying it with its verifier, does.
    const replay = await provider.exchange(code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(first.access_token)).body).toEqual({ active: false });
    expect(await (await provider.refresh(first.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });

    // Two concurrent redemptions: one wins the single-use claim, the loser is a
    // replay, and the replay revokes what the winner received.
    const racing = (await provider.authorize()).searchParams.get('code')!;
    const results = await Promise.all([provider.exchange(racing), provider.exchange(racing)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const winner = await results.find((result) => result.status === 200)!.json() as { access_token: string };
    expect((await provider.introspect(winner.access_token)).body).toEqual({ active: false });
  });

  it('PKCE mismatch: only S256 is accepted and a wrong code_verifier is refused (RFC 7636 4.3, 4.4.1, 4.6)', async () => {
    const provider = await setupProvider();
    for (const overrides of [
      { code_challenge: undefined, code_challenge_method: undefined },
      { code_challenge_method: 'plain', code_challenge: RFC7636_VERIFIER },
      { code_challenge_method: undefined }
    ]) {
      const response = await provider.getAuthorize(provider.authorizeQuery(overrides));
      const location = new URL(response.headers.get('location')!);
      expect(response.status).toBe(302);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe('xyz');
      expect(location.searchParams.has('code')).toBe(false);
    }

    const code = (await provider.authorize()).searchParams.get('code')!;
    const wrong = await provider.exchange(code, { code_verifier: 'x'.repeat(43) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
    const missing = await provider.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: RFC6749_CLIENT.redirectUris[0]
    }, { authorization: 'Basic czZCaGRSa3F0MzpnWDFmQmF0M2JW' });
    expect(await missing.json()).toMatchObject({ error: 'invalid_request' });

    // A wrong verifier does not spend the code, so a stolen code cannot be
    // used to lock out the client holding the real verifier.
    expect((await provider.exchange(code)).status).toBe(200);
  });

  it('refresh reuse: refresh rotates, and replaying a rotated refresh token revokes the whole grant', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();

    const rotated = await (await provider.refresh(issued.refresh_token)).json() as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    expect(rotated.scope).toBe('memotron:read memotron:write');
    expect((await provider.introspect(rotated.access_token)).body.active).toBe(true);

    const reuse = await provider.refresh(issued.refresh_token);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(rotated.access_token)).body).toEqual({ active: false });
    expect((await provider.introspect(issued.access_token)).body).toEqual({ active: false });
    expect(await (await provider.refresh(rotated.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('wrong audience: a token bound to one resource is inactive at another (RFC 8707 2, 2.2)', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();

    const elsewhere = await provider.introspect(issued.access_token, POINTRON_SECRET);
    expect(elsewhere).toEqual({ status: 200, body: { active: false } });
    expect(await verifyOAuthAccessToken({ database: provider.database }, issued.access_token, {
      resource: POINTRON,
      now: provider.now
    })).toBeNull();

    // The grant cannot be stretched to another resource at the token endpoint.
    const retarget = await provider.refresh(issued.refresh_token, { resource: POINTRON });
    expect(await retarget.json()).toMatchObject({ error: 'invalid_target' });

    // RFC 8707 2: an unknown resource or one with a fragment is invalid_target.
    for (const resource of ['https://unknown.example.com/', `${MEMOTRON}#frag`, undefined]) {
      const response = await provider.getAuthorize(provider.authorizeQuery({ resource }));
      expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    }
  });

  it('revoked grant: revoking the refresh token or the grant stops every token under it (RFC 7009 2.1)', async () => {
    const provider = await setupProvider();
    const viaRevocation = await provider.obtainTokens();
    const revoked = await provider.revoke(viaRevocation.refresh_token);
    expect(revoked.status).toBe(200);
    expect((await provider.introspect(viaRevocation.access_token)).body).toEqual({ active: false });
    expect(await (await provider.refresh(viaRevocation.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });

    // Revoking an access token revokes only that token.
    const accessOnly = await provider.obtainTokens();
    await provider.revoke(accessOnly.access_token);
    expect((await provider.introspect(accessOnly.access_token)).body).toEqual({ active: false });
    expect((await provider.refresh(accessOnly.refresh_token)).status).toBe(200);

    // A host disconnecting the app revokes the grant for its own user only.
    const disconnected = await provider.obtainTokens();
    const info = await verifyOAuthAccessToken({ database: provider.database }, disconnected.access_token, {
      resource: MEMOTRON,
      now: provider.now
    });
    expect(await revokeOAuthGrant({ database: provider.database }, info!.grantId, { userId: 'someone-else' })).toBe(false);
    expect((await provider.introspect(disconnected.access_token)).body.active).toBe(true);
    expect(await revokeOAuthGrant({ database: provider.database }, info!.grantId, { userId: provider.user.id })).toBe(true);
    expect((await provider.introspect(disconnected.access_token)).body).toEqual({ active: false });
    expect(await (await provider.refresh(disconnected.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });

    // Disconnecting a trusted client: every authorization makes its own grant,
    // so Rhombus signed in twice holds two grants plus a pending code. All of
    // them stop working, its consent is forgotten, and the user's other
    // clients and resources are untouched.
    const rhombus = (resource = MEMOTRON) => ({
      client_id: RHOMBUS.clientId,
      redirect_uri: RHOMBUS.redirectUris[0],
      resource
    });
    const rhombusCode = async (resource = MEMOTRON) =>
      (await provider.authorize(rhombus(resource), RHOMBUS)).searchParams.get('code')!;
    const rhombusExchange = (code: string) => provider.token({
      grant_type: 'authorization_code',
      client_id: RHOMBUS.clientId,
      code,
      redirect_uri: RHOMBUS.redirectUris[0],
      code_verifier: RFC7636_VERIFIER
    });
    const rhombusRefresh = (refreshToken: string) =>
      provider.token({ grant_type: 'refresh_token', client_id: RHOMBUS.clientId, refresh_token: refreshToken });
    type Tokens = { access_token: string; refresh_token: string };
    const rhombusTokens = async (resource = MEMOTRON) =>
      await (await rhombusExchange(await rhombusCode(resource))).json() as Tokens;
    const verify = (token: string, resource = MEMOTRON) =>
      verifyOAuthAccessToken({ database: provider.database }, token, { resource, now: provider.now });

    const consentsBefore = provider.consents.length;
    const laptop = await rhombusTokens();
    const phone = await rhombusTokens();
    const pending = await rhombusCode();
    expect(provider.consents).toHaveLength(consentsBefore + 1);
    const pointron = await rhombusTokens(POINTRON);
    const otherClient = await provider.obtainTokens();
    const laptopGrant = (await verify(laptop.access_token))!.grantId;
    expect((await verify(phone.access_token))!.grantId).not.toBe(laptopGrant);

    expect(await revokeOAuthGrant({ database: provider.database }, laptopGrant, { userId: provider.user.id })).toBe(true);
    for (const tokens of [laptop, phone]) {
      expect((await provider.introspect(tokens.access_token)).body).toEqual({ active: false });
      expect(await verify(tokens.access_token)).toBeNull();
      const refreshed = await rhombusRefresh(tokens.refresh_token);
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
    }
    expect(await (await rhombusExchange(pending)).json()).toMatchObject({ error: 'invalid_grant' });

    const consentsAtDisconnect = provider.consents.length;
    const afterDisconnect = await provider.getAuthorize(provider.authorizeQuery(rhombus(), RHOMBUS));
    expect(afterDisconnect.status).toBe(200);
    expect(afterDisconnect.headers.get('location')).toBeNull();
    expect(provider.consents).toHaveLength(consentsAtDisconnect + 1);
    expect(provider.consents[consentsAtDisconnect]).toMatchObject({ client: { clientId: RHOMBUS.clientId }, resource: MEMOTRON });

    expect(await verify(pointron.access_token, POINTRON)).not.toBeNull();
    expect((await rhombusRefresh(pointron.refresh_token)).status).toBe(200);
    expect((await provider.introspect(otherClient.access_token)).body.active).toBe(true);
    expect((await provider.refresh(otherClient.refresh_token)).status).toBe(200);
    const silent = await provider.getAuthorize(provider.authorizeQuery(rhombus(POINTRON), RHOMBUS));
    expect(new URL(silent.headers.get('location')!).searchParams.get('code')).toEqual(expect.any(String));

    // The same disconnect, keyed by user, client and resource.
    expect(await disconnectOAuthClient({ database: provider.database }, {
      userId: provider.user.id,
      clientId: RHOMBUS.clientId,
      resource: POINTRON
    })).toBeGreaterThan(0);
    expect(await verify(pointron.access_token, POINTRON)).toBeNull();
    expect((await provider.getAuthorize(provider.authorizeQuery(rhombus(POINTRON), RHOMBUS))).status).toBe(200);
  });
});

describe('token lifetimes', () => {
  it('access tokens live one hour; refresh tokens live 30 days from each rotation', async () => {
    const provider = await setupProvider();
    const issued = await provider.obtainTokens();
    provider.advance(3599);
    expect((await provider.introspect(issued.access_token)).body.active).toBe(true);
    provider.advance(1);
    expect((await provider.introspect(issued.access_token)).body).toEqual({ active: false });

    provider.advance(30 * 24 * 3600 - 3600 - 1);
    const rotated = await provider.refresh(issued.refresh_token);
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as { refresh_token: string };
    provider.advance(30 * 24 * 3600);
    expect(await (await provider.refresh(next.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('a code expires after one minute', async () => {
    const provider = await setupProvider();
    const code = (await provider.authorize()).searchParams.get('code')!;
    provider.advance(60);
    expect(await (await provider.exchange(code)).json()).toMatchObject({ error: 'invalid_grant' });
  });
});
