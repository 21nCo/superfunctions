// Runs inside workerd (vitest.workerd.config.ts) without nodejs_compat, so it checks that the issuer needs only the
// Workers WebCrypto, URL and fetch globals. Keys are generated per run; no key material is committed.
import { createLocalJWKSet, errors as joseErrors, type JSONWebKeySet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { createOidcIssuer, OidcIssuerError } from '../../index.js';
import { generateSigner, get, ISSUER, ring } from '../helpers.js';

describe('OIDC issuer on workerd', () => {
  it('serves discovery and JWKS, mints verifiable tokens and drops a retired kid', async () => {
    const first = await generateSigner();
    const second = await generateSigner();
    const before = createOidcIssuer({ issuer: ISSUER, keyRing: ring([['key-1', 'active', first]]) });

    const discovery = before.discoveryHandler(get(before.discoveryUrl));
    expect(discovery.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await discovery.json()).toMatchObject({ issuer: ISSUER, jwks_uri: before.jwksUri, id_token_signing_alg_values_supported: ['ES256'] });

    const token = await before.mintIdToken({ sub: 'user-1', aud: 'client-a', ttl: 3600, claims: { tenant: 'tenant-1' } });
    const beforeJwks = createLocalJWKSet((await before.jwksHandler(get(before.jwksUri)).json()) as JSONWebKeySet);
    const { payload } = await jwtVerify(token, beforeJwks, { issuer: ISSUER, audience: 'client-a', algorithms: ['ES256'] });
    expect(payload).toMatchObject({ sub: 'user-1', tenant: 'tenant-1' });
    expect(payload.exp! - payload.iat!).toBe(3600);

    const after = createOidcIssuer({ issuer: ISSUER, keyRing: ring([['key-1', 'retired', first], ['key-2', 'active', second]]) });
    const afterJwks = createLocalJWKSet((await after.jwksHandler(get(after.jwksUri)).json()) as JSONWebKeySet);
    await expect(jwtVerify(token, afterJwks, { issuer: ISSUER, audience: 'client-a' })).rejects.toBeInstanceOf(joseErrors.JWKSNoMatchingKey);
  });

  it('rejects a reserved claim and a lifetime over one hour', async () => {
    const issuer = createOidcIssuer({ issuer: ISSUER, keyRing: ring([['key-1', 'active', await generateSigner()]]) });
    const reserved = await issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', claims: { exp: 0 } }).catch((caught: unknown) => caught);
    expect((reserved as OidcIssuerError).code).toBe('reserved-claim');
    for (const claims of [{ azp: 'client-b' }, { toJSON: () => ({ azp: 'client-b' }) }]) {
      const azp = await issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', claims }).catch((caught: unknown) => caught);
      expect((azp as OidcIssuerError).code).toBe('reserved-claim');
    }
    const tooLong = await issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', ttl: 3601 }).catch((caught: unknown) => caught);
    expect((tooLong as OidcIssuerError).code).toBe('invalid-ttl');
  });
});
