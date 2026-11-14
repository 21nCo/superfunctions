import { describe, expect, it } from 'vitest';
import { disconnectOAuthClient, revokeOAuthGrant, verifyOAuthAccessToken } from '../index.js';
import { MEMOTRON, setupProvider } from './harness.js';

type Tokens = { access_token: string; refresh_token: string };

describe('SQL storage (shipped Kysely adapter on SQLite)', () => {
  it('claims a code or refresh token once, revokes on replay and reuse, and disconnects', async () => {
    const provider = await setupProvider({ sql: true });
    const store = { database: provider.database };
    const code = (await provider.authorize()).searchParams.get('code')!;
    const first = await provider.exchange(code);
    expect(first.status).toBe(200);
    const issued = await first.json() as Tokens;
    expect((await provider.introspect(issued.access_token)).body.active).toBe(true);

    const rotated = await provider.refresh(issued.refresh_token);
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as Tokens;
    expect((await provider.introspect(next.access_token)).body.active).toBe(true);
    const reuse = await provider.refresh(issued.refresh_token);
    expect(await reuse.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(next.access_token)).body).toEqual({ active: false });

    const replayed = (await provider.authorize()).searchParams.get('code')!;
    const winner = await (await provider.exchange(replayed)).json() as Tokens;
    expect(await (await provider.exchange(replayed)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(winner.access_token)).body).toEqual({ active: false });

    const granted = await provider.obtainTokens();
    const info = await verifyOAuthAccessToken(store, granted.access_token, { resource: MEMOTRON, now: provider.now });
    expect(await revokeOAuthGrant(store, info!.grantId, { userId: provider.user.id })).toBe(true);
    expect((await provider.introspect(granted.access_token)).body).toEqual({ active: false });

    const disconnected = await provider.obtainTokens();
    const triple = { userId: provider.user.id, clientId: info!.clientId, resource: MEMOTRON };
    expect(await disconnectOAuthClient(store, triple)).toBe(1);
    expect((await provider.introspect(disconnected.access_token)).body).toEqual({ active: false });
  });
});

describe.each([['memory', false], ['SQL', true]])('token issuance failure (%s)', (_, sql) => {
  const tokenRows = async (provider: Awaited<ReturnType<typeof setupProvider>>) =>
    (await provider.database.findMany({ model: 'oauth_provider_tokens', namespace: 'authfn' })).length;

  it.each(['access', 'refresh'])('a failed %s token write leaves the code redeemable once', async (kind) => {
    const provider = await setupProvider({ sql });
    const code = (await provider.authorize()).searchParams.get('code')!;
    provider.control.failNext('oauth_provider_tokens', ({ data }) => data?.kind === kind);
    expect((await provider.exchange(code)).status).toBe(500);
    expect(await tokenRows(provider)).toBe(0);

    const retried = await provider.exchange(code);
    expect(retried.status).toBe(200);
    const issued = await retried.json() as Tokens;
    expect(await (await provider.exchange(code)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(issued.access_token)).body).toEqual({ active: false });
  });

  // An exchange reads the code, claims it, reads it back, then reads the grant.
  it.each([
    ['claim write (committed, unacknowledged)', 'oauth_provider_codes', 1, 'updateMany'],
    ['claim read-back', 'oauth_provider_codes', 2, 'findOne'],
    ['grant lookup', 'oauth_provider_grants', 1, 'findOne']
  ] as const)(
    'a failed %s leaves the code redeemable once',
    async (_step, model, nth, operation) => {
      const provider = await setupProvider({ sql });
      const code = (await provider.authorize()).searchParams.get('code')!;
      let calls = 0;
      provider.control.failNext(model, () => ++calls === nth, operation);
      expect((await provider.exchange(code)).status).toBe(500);
      const retried = await provider.exchange(code);
      expect(retried.status).toBe(200);
      const issued = await retried.json() as Tokens;
      expect((await provider.introspect(issued.access_token)).body.active).toBe(true);
    }
  );

  it('a failed read after a reuse revocation leaves the grant revoked', async () => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    const next = await (await provider.refresh(issued.refresh_token)).json() as Tokens;
    // Reusing the spent refresh token revokes the grant; its read-back fails.
    provider.control.failNext('oauth_provider_grants', () => true, 'findOne');
    expect((await provider.refresh(issued.refresh_token)).status).toBe(500);
    expect((await provider.introspect(next.access_token)).body).toEqual({ active: false });
    const grants = await provider.database.findMany<{ revokedAt: Date | null; updatedAt: Date | null }>({
      model: 'oauth_provider_grants',
      namespace: 'authfn'
    });
    expect(grants).toEqual([expect.objectContaining({ revokedAt: expect.any(Date), updatedAt: expect.any(Date) })]);
  });

  it('a refresh claim that commits but loses its acknowledgement leaves the refresh token redeemable once', async () => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    provider.control.failNext('oauth_provider_tokens', () => true, 'updateMany');
    expect((await provider.refresh(issued.refresh_token)).status).toBe(500);
    const retried = await provider.refresh(issued.refresh_token);
    expect(retried.status).toBe(200);
    expect((await provider.introspect((await retried.json() as Tokens).access_token)).body.active).toBe(true);
  });

  it.each(['access', 'refresh'])('a failed %s token write leaves the refresh token redeemable once', async (kind) => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    provider.control.failNext('oauth_provider_tokens', ({ data }) => data?.kind === kind);
    expect((await provider.refresh(issued.refresh_token)).status).toBe(500);
    expect(await tokenRows(provider)).toBe(2);
    expect((await provider.introspect(issued.access_token)).body.active).toBe(true);

    const retried = await provider.refresh(issued.refresh_token);
    expect(retried.status).toBe(200);
    const next = await retried.json() as Tokens;
    expect(await (await provider.refresh(issued.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(next.access_token)).body).toEqual({ active: false });
  });
});
