import { describe, expect, it } from 'vitest';
import { disconnectOAuthClient, revokeOAuthGrant, verifyOAuthAccessToken, type OAuthTokenRecord } from '../index.js';
import { activeTokenState } from '../store.js';
import { MEMOTRON, RFC6749_CLIENT, setupProvider } from './harness.js';

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

type Provider = Awaited<ReturnType<typeof setupProvider>>;

const userWhere = (provider: Provider) => [{ field: 'id', operator: 'eq' as const, value: provider.user.id }];

const tokenRecords = (provider: Provider) =>
  provider.database.findMany<OAuthTokenRecord>({ model: 'oauth_provider_tokens', namespace: 'authfn' });

/** The stored token rows that the validity rule accepts. */
async function activeRows(provider: Provider): Promise<OAuthTokenRecord[]> {
  const store = { database: provider.database };
  const active: OAuthTokenRecord[] = [];
  for (const record of await tokenRecords(provider)) {
    if (await activeTokenState(store, record, record.kind, provider.now())) {
      active.push(record);
    }
  }
  return active;
}

const storedClaimId = async (provider: Provider, model: string, id: string) =>
  (await provider.database.findOne<{ claimId: string | null }>({
    model,
    where: [{ field: 'id', operator: 'eq', value: id }],
    namespace: 'authfn'
  }))?.claimId;

// The claim on the code or refresh token is the single commit point: tokens
// are staged before it and are valid only once it stores their claim ID.
describe.each([['memory', false], ['SQL', true]])('token issuance commit point (%s)', (_, sql) => {
  it.each(['access', 'refresh'])('a failed %s token write leaves the code redeemable once and its staged rows inert', async (kind) => {
    const provider = await setupProvider({ sql });
    const code = (await provider.authorize()).searchParams.get('code')!;
    provider.control.failNext('oauth_provider_tokens', ({ data }) => data?.kind === kind);
    expect((await provider.exchange(code)).status).toBe(500);
    expect(await activeRows(provider)).toEqual([]);

    const retried = await provider.exchange(code);
    expect(retried.status).toBe(200);
    const issued = await retried.json() as Tokens;
    expect(await tokenRecords(provider)).toHaveLength(kind === 'access' ? 2 : 3);
    expect((await activeRows(provider)).map((row) => row.kind).sort()).toEqual(['access', 'refresh']);
    expect(await (await provider.exchange(code)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(issued.access_token)).body).toEqual({ active: false });
  });

  it.each(['access', 'refresh'])('a failed %s token write leaves the refresh token redeemable once and its staged rows inert', async (kind) => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    provider.control.failNext('oauth_provider_tokens', ({ data }) => data?.kind === kind);
    expect((await provider.refresh(issued.refresh_token)).status).toBe(500);
    expect(await activeRows(provider)).toHaveLength(2);
    expect((await provider.introspect(issued.access_token)).body.active).toBe(true);

    const retried = await provider.refresh(issued.refresh_token);
    expect(retried.status).toBe(200);
    const next = await retried.json() as Tokens;
    // The original pair and the retry's pair; never the failed attempt's row.
    expect(await activeRows(provider)).toHaveLength(4);
    expect(await (await provider.refresh(issued.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await provider.introspect(next.access_token)).body).toEqual({ active: false });
  });

  it('a code claim write that fails before applying leaves the code redeemable and nothing active', async () => {
    const provider = await setupProvider({ sql });
    const code = (await provider.authorize()).searchParams.get('code')!;
    provider.control.failNext('oauth_provider_codes', () => true, 'updateManyRejected');
    expect((await provider.exchange(code)).status).toBe(500);
    expect(await tokenRecords(provider)).toHaveLength(2);
    expect(await activeRows(provider)).toEqual([]);
    const retried = await provider.exchange(code);
    expect(retried.status).toBe(200);
    expect((await provider.introspect((await retried.json() as Tokens).access_token)).body.active).toBe(true);
  });

  it.each([
    ['code', 'oauth_provider_codes'],
    ['refresh', 'oauth_provider_tokens']
  ] as const)('a %s claim that commits but loses its acknowledgement is decided by its read-back', async (grant, model) => {
    const provider = await setupProvider({ sql });
    const code = (await provider.authorize()).searchParams.get('code')!;
    let response: Response;
    if (grant === 'code') {
      provider.control.failNext(model, () => true, 'updateMany');
      response = await provider.exchange(code);
    } else {
      const issued = await (await provider.exchange(code)).json() as Tokens;
      provider.control.failNext(model, () => true, 'updateMany');
      response = await provider.refresh(issued.refresh_token);
    }
    expect(response.status).toBe(200);
    expect((await provider.introspect((await response.json() as Tokens).access_token)).body.active).toBe(true);
  });

  it('a claim whose acknowledgement and read-back both fail is spent: a retry is a replay that revokes the grant', async () => {
    const provider = await setupProvider({ sql });
    const code = (await provider.authorize()).searchParams.get('code')!;
    let codeReads = 0;
    provider.control.failNext('oauth_provider_codes', () => true, 'updateMany');
    // findCode is the first read of the code row; the claim read-back the second.
    provider.control.failNext('oauth_provider_codes', () => ++codeReads === 2, 'findOne');
    expect((await provider.exchange(code)).status).toBe(500);
    // The claim committed, so the undelivered tokens are active until the replay.
    expect(await activeRows(provider)).toHaveLength(2);
    expect(await (await provider.exchange(code)).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await activeRows(provider)).toEqual([]);
  });

  it('of two concurrent exchanges of one code, one succeeds and the loser\'s staged tokens never become valid', async () => {
    const provider = await setupProvider({ sql });
    const callback = await provider.authorize();
    const code = callback.searchParams.get('code')!;
    const statuses = (await Promise.all([provider.exchange(code), provider.exchange(code)])).map((response) => response.status);
    expect(statuses.sort()).toEqual([200, 400]);
    const codeRow = (await provider.database.findMany<{ id: string }>({ model: 'oauth_provider_codes', namespace: 'authfn' }))[0];
    const committed = await storedClaimId(provider, 'oauth_provider_codes', codeRow.id);
    const rows = await tokenRecords(provider);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.issuingClaimId === committed)).toHaveLength(2);
    expect(await activeRows(provider)).toEqual([]);
  });

  it('of two concurrent rotations of one refresh token, one succeeds and the loser\'s staged tokens never become valid', async () => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    const statuses = (await Promise.all([provider.refresh(issued.refresh_token), provider.refresh(issued.refresh_token)]))
      .map((response) => response.status);
    expect(statuses.sort()).toEqual([200, 400]);
    const rows = await tokenRecords(provider);
    const parent = rows.find((row) => row.kind === 'refresh' && row.rotatedAt)!;
    const children = rows.filter((row) => row.sourceId === parent.id);
    expect(children).toHaveLength(4);
    const committed = await storedClaimId(provider, 'oauth_provider_tokens', parent.id);
    expect(children.filter((row) => row.issuingClaimId === committed)).toHaveLength(2);
    expect(await activeRows(provider)).toEqual([]);
  });

  // Each event ends the grant while the first token insert is paused, so it
  // completes before the claim commits; the exchange must not return tokens.
  const endings = {
    disconnect: (provider: Provider) => disconnectOAuthClient({ database: provider.database },
      { userId: provider.user.id, clientId: RFC6749_CLIENT.clientId, resource: MEMOTRON }),
    disable: (provider: Provider) => provider.database.updateMany({
      model: 'users', where: userWhere(provider), data: { metadata: { disabled: true } }, namespace: 'authfn'
    }),
    delete: (provider: Provider) => provider.database.deleteMany({ model: 'users', where: userWhere(provider), namespace: 'authfn' })
  };
  describe.each(['code', 'refresh'] as const)('a %s exchange', (flow) => {
    it.each(Object.keys(endings) as (keyof typeof endings)[])('during which a %s completes is invalid_grant and leaves nothing active', async (ending) => {
      const provider = await setupProvider({ sql });
      let send: () => Promise<Response>;
      if (flow === 'code') {
        const code = (await provider.authorize()).searchParams.get('code')!;
        send = () => provider.exchange(code);
      } else {
        const issued = await provider.obtainTokens();
        send = () => provider.refresh(issued.refresh_token);
      }
      const staging = provider.control.arm('oauth_provider_tokens');
      const pending = send();
      await staging;
      await endings[ending](provider);
      provider.control.release();
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
      expect(await activeRows(provider)).toEqual([]);
      // The credential stays spent.
      expect(await (await send()).json()).toMatchObject({ error: 'invalid_grant' });
    });
  });

  it('a rotation during which the refresh token is revoked (RFC 7009) is invalid_grant', async () => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    const staging = provider.control.arm('oauth_provider_tokens');
    const pending = provider.refresh(issued.refresh_token);
    await staging;
    expect((await provider.revoke(issued.refresh_token)).status).toBe(200);
    provider.control.release();
    expect(await (await pending).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await activeRows(provider)).toEqual([]);
  });

  it('a disconnect after the response revokes the delivered tokens', async () => {
    const provider = await setupProvider({ sql });
    const issued = await provider.obtainTokens();
    await endings.disconnect(provider);
    expect((await provider.introspect(issued.access_token)).body).toEqual({ active: false });
    expect(await (await provider.refresh(issued.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('a failed grant lookup leaves the code redeemable once', async () => {
    const provider = await setupProvider({ sql });
    const code = (await provider.authorize()).searchParams.get('code')!;
    provider.control.failNext('oauth_provider_grants', () => true, 'findOne');
    expect((await provider.exchange(code)).status).toBe(500);
    const retried = await provider.exchange(code);
    expect(retried.status).toBe(200);
    expect((await provider.introspect((await retried.json() as Tokens).access_token)).body.active).toBe(true);
  });

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
});
