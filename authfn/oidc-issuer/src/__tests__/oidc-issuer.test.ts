import { type Es256Signer, KeyRingError, type SigningKeyRing } from '@secfn/keys';
import { createLocalJWKSet, decodeProtectedHeader, errors as joseErrors, type JSONWebKeySet, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createOidcIssuer, MAX_ID_TOKEN_TTL_SECONDS, OidcIssuerError, type OidcIssuerOptions, RESERVED_CLAIMS } from '../index.js';
import { generateSigner, get, ISSUER, ring } from './helpers.js';

let first: Es256Signer;
let second: Es256Signer;
let activeRing: SigningKeyRing;

beforeAll(async () => {
  first = await generateSigner();
  second = await generateSigner();
  activeRing = ring([['key-1', 'active', first]]);
});

function issuerWith(overrides: Partial<OidcIssuerOptions> = {}) {
  return createOidcIssuer({ issuer: ISSUER, keyRing: activeRing, ...overrides });
}

async function served(handler: (request: Request) => Response, url: string): Promise<unknown> {
  const response = handler(get(url));
  expect(response.status).toBe(200);
  return response.json();
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OidcIssuerError);
    return (error as OidcIssuerError).code;
  }
  return undefined;
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OidcIssuerError);
  return (error as OidcIssuerError).code;
}

describe('createOidcIssuer options', () => {
  it.each([
    ['http scheme', 'http://issuer.example.test'],
    ['relative URL', '/tenant-1'],
    ['query', 'https://issuer.example.test/tenant-1?tenant=1'],
    ['empty query', 'https://issuer.example.test/tenant-1?'],
    ['fragment', 'https://issuer.example.test/tenant-1#top'],
    ['empty fragment', 'https://issuer.example.test/tenant-1#'],
    ['user info', 'https://user@issuer.example.test'],
    ['uppercase host', 'https://Issuer.Example.Test'],
    ['default port', 'https://issuer.example.test:443/tenant-1'],
    ['dot segment', 'https://issuer.example.test/a/../tenant-1'],
    ['surrounding space', ' https://issuer.example.test'],
    ['empty string', ''],
    ['non-string', 42],
  ])('rejects an issuer with %s', (_label, issuer) => {
    expect(codeOf(() => createOidcIssuer({ issuer: issuer as string, keyRing: activeRing }))).toBe('invalid-options');
  });

  it('accepts a bare origin with or without its trailing slash and keeps it verbatim', () => {
    const bare = createOidcIssuer({ issuer: 'https://issuer.example.test', keyRing: activeRing });
    expect(bare.issuer).toBe('https://issuer.example.test');
    expect(bare.discoveryUrl).toBe('https://issuer.example.test/.well-known/openid-configuration');
    const slashed = createOidcIssuer({ issuer: 'https://issuer.example.test/', keyRing: activeRing });
    expect(slashed.issuer).toBe('https://issuer.example.test/');
    expect(slashed.jwksUri).toBe('https://issuer.example.test/.well-known/jwks.json');
  });

  it.each([0, -1, 1.5, MAX_ID_TOKEN_TTL_SECONDS + 1, Number.NaN, '300'])('rejects defaultTtl %s', (defaultTtl) => {
    expect(codeOf(() => issuerWith({ defaultTtl: defaultTtl as number }))).toBe('invalid-options');
  });

  it('rejects a jwksUri that is not https or has a fragment', () => {
    expect(codeOf(() => issuerWith({ jwksUri: 'http://issuer.example.test/jwks' }))).toBe('invalid-options');
    expect(codeOf(() => issuerWith({ jwksUri: 'https://issuer.example.test/jwks#keys' }))).toBe('invalid-options');
  });

  it('rejects a key ring whose JWKS omits the active kid or carries private members', () => {
    const omitsActive = { activeKid: 'key-2', sign: activeRing.sign, jwks: activeRing.jwks };
    expect(codeOf(() => issuerWith({ keyRing: omitsActive }))).toBe('invalid-options');
    const leaky = { ...activeRing, jwks: () => ({ keys: activeRing.jwks().keys.map((key) => ({ ...key, d: 'example-private-member' })) }) };
    expect(codeOf(() => issuerWith({ keyRing: leaky }))).toBe('invalid-options');
    expect(codeOf(() => issuerWith({ keyRing: {} as SigningKeyRing }))).toBe('invalid-options');
  });

  it('rejects claimsSupported entries that are not claim names', () => {
    expect(codeOf(() => issuerWith({ claimsSupported: ['email', ''] }))).toBe('invalid-options');
    expect(codeOf(() => issuerWith({ claimsSupported: ['has space'] }))).toBe('invalid-options');
  });
});

describe('discovery and JWKS handlers', () => {
  it('serves the discovery document with the contracted members and cache headers', async () => {
    const issuer = issuerWith({ claimsSupported: ['email', 'sub'] });
    expect(issuer.discoveryUrl).toBe(`${ISSUER}/.well-known/openid-configuration`);
    const response = issuer.discoveryHandler(get(issuer.discoveryUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      claims_supported: ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti', 'email'],
    });
    expect(Object.isFrozen(issuer.discovery.claims_supported)).toBe(true);
  });

  it('publishes a configured jwksUri in its normalized form', async () => {
    const issuer = issuerWith({ jwksUri: 'https://keys.example.test/oidc/jwks?tenant=1' });
    expect(await served(issuer.discoveryHandler, issuer.discoveryUrl)).toMatchObject({ jwks_uri: 'https://keys.example.test/oidc/jwks?tenant=1' });
  });

  it('serves only the public members of the active and verify-only keys', async () => {
    const issuer = issuerWith({
      keyRing: ring([
        ['key-0', 'retired', first],
        ['key-1', 'verify-only', first],
        ['key-2', 'active', second],
      ]),
    });
    const response = issuer.jwksHandler(get(issuer.jwksUri));
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      keys: [
        { kty: 'EC', crv: 'P-256', x: first.publicJwk.x, y: first.publicJwk.y, kid: 'key-1', alg: 'ES256', use: 'sig' },
        { kty: 'EC', crv: 'P-256', x: second.publicJwk.x, y: second.publicJwk.y, kid: 'key-2', alg: 'ES256', use: 'sig' },
      ],
    });
  });

  it('answers HEAD with headers and no body, and other methods with 405', async () => {
    const issuer = issuerWith();
    for (const handler of [issuer.discoveryHandler, issuer.jwksHandler]) {
      const head = handler(get(issuer.discoveryUrl, 'HEAD'));
      expect(head.status).toBe(200);
      expect(head.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await head.text()).toBe('');
      const post = handler(get(issuer.discoveryUrl, 'POST'));
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET, HEAD');
      expect(post.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('mintIdToken', () => {
  it('mints a token that jose.jwtVerify accepts against the served JWKS', async () => {
    const now = Date.UTC(2026, 10, 28, 12, 0, 0);
    const issuer = issuerWith({ defaultTtl: 600, now: () => now, claimsSupported: ['email'] });
    const token = await issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', claims: { email: 'user-1@example.test' } });
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'key-1', typ: 'JWT' });

    const jwks = createLocalJWKSet((await served(issuer.jwksHandler, issuer.jwksUri)) as JSONWebKeySet);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: 'client-a',
      algorithms: ['ES256'],
      currentDate: new Date(now + 1000),
    });
    const iat = now / 1000;
    expect(payload).toMatchObject({ iss: ISSUER, sub: 'user-1', aud: 'client-a', iat, nbf: iat, exp: iat + 600, email: 'user-1@example.test' });
    expect(payload.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(jwtVerify(token, jwks, { issuer: ISSUER, audience: 'client-a', currentDate: new Date(now + 601_000) })).rejects.toBeInstanceOf(
      joseErrors.JWTExpired,
    );
  });

  it('signs a list audience with the default lifetime, verifiable via the discovered jwks_uri', async () => {
    const issuer = issuerWith();
    const metadata = (await served(issuer.discoveryHandler, issuer.discoveryUrl)) as { jwks_uri: string; issuer: string };
    expect(metadata.jwks_uri).toBe(issuer.jwksUri);
    const jwks = createLocalJWKSet((await served(issuer.jwksHandler, metadata.jwks_uri)) as JSONWebKeySet);
    const token = await issuer.mintIdToken({ sub: 'user-1', aud: ['client-a', 'client-b'] });
    const { payload } = await jwtVerify(token, jwks, { issuer: metadata.issuer, audience: 'client-b' });
    expect(payload.aud).toEqual(['client-a', 'client-b']);
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it.each(RESERVED_CLAIMS)('rejects claims that override reserved claim %s', async (name) => {
    const sign = vi.fn(activeRing.sign);
    const issuer = createOidcIssuer({ issuer: ISSUER, keyRing: { activeKid: activeRing.activeKid, jwks: activeRing.jwks, sign } });
    expect(await rejectionCode(issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', claims: { [name]: 'override' } }))).toBe('reserved-claim');
    expect(await rejectionCode(issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', claims: { [name]: undefined } }))).toBe('reserved-claim');
    const sneaky = { toJSON: () => ({ [name]: 'override' }) };
    expect(await rejectionCode(issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', claims: sneaky }))).toBe('reserved-claim');
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    ['an array', []],
    ['a Map', new Map([['email', 'user-1@example.test']])],
    ['a class instance', new (class Claims {})()],
    ['a BigInt value', { count: 1n }],
    ['a __proto__ claim', JSON.parse('{"__proto__":{"admin":true}}') as Record<string, unknown>],
  ])('rejects claims that are %s', async (_label, claims) => {
    expect(await rejectionCode(issuerWith().mintIdToken({ sub: 'user-1', aud: 'client-a', claims: claims as Record<string, unknown> }))).toBe(
      'invalid-claims',
    );
  });

  it('rejects a lifetime over one hour and accepts exactly one hour', async () => {
    const issuer = issuerWith();
    expect(await rejectionCode(issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', ttl: MAX_ID_TOKEN_TTL_SECONDS + 1 }))).toBe('invalid-ttl');
    for (const ttl of [0, -60, 30.5, Number.POSITIVE_INFINITY]) {
      expect(await rejectionCode(issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', ttl }))).toBe('invalid-ttl');
    }
    const token = await issuer.mintIdToken({ sub: 'user-1', aud: 'client-a', ttl: MAX_ID_TOKEN_TTL_SECONDS });
    const verified = await activeRing.verify(token);
    const payload = JSON.parse(new TextDecoder().decode(verified.payload)) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(MAX_ID_TOKEN_TTL_SECONDS);
  });

  it.each([
    ['empty', ''],
    ['too long', 'u'.repeat(256)],
    ['non-ASCII', 'usér'],
    ['control character', 'user\n1'],
    ['leading space', ' user-1'],
    ['non-string', 7],
  ])('rejects a %s sub', async (_label, sub) => {
    expect(await rejectionCode(issuerWith().mintIdToken({ sub: sub as string, aud: 'client-a' }))).toBe('invalid-subject');
  });

  it.each([
    ['empty string', ''],
    ['empty array', []],
    ['array with an empty entry', ['client-a', '']],
    ['duplicate entries', ['client-a', 'client-a']],
    ['non-string entry', ['client-a', 1]],
    ['non-string', 1],
  ])('rejects aud as %s', async (_label, aud) => {
    expect(await rejectionCode(issuerWith().mintIdToken({ sub: 'user-1', aud: aud as string }))).toBe('invalid-audience');
  });

  it('a token signed by a retired kid fails verification against the rotated JWKS', async () => {
    const before = issuerWith({ keyRing: ring([['key-1', 'active', first]]) });
    const earlier = await before.mintIdToken({ sub: 'user-1', aud: 'client-a' });

    const during = issuerWith({ keyRing: ring([['key-1', 'verify-only', first], ['key-2', 'active', second]]) });
    const duringJwks = createLocalJWKSet((await served(during.jwksHandler, during.jwksUri)) as JSONWebKeySet);
    expect((await jwtVerify(earlier, duringJwks, { issuer: ISSUER, audience: 'client-a' })).protectedHeader.kid).toBe('key-1');

    const afterRing = ring([['key-1', 'retired', first], ['key-2', 'active', second]]);
    const after = issuerWith({ keyRing: afterRing });
    const afterJwks = createLocalJWKSet((await served(after.jwksHandler, after.jwksUri)) as JSONWebKeySet);
    await expect(jwtVerify(earlier, afterJwks, { issuer: ISSUER, audience: 'client-a' })).rejects.toBeInstanceOf(joseErrors.JWKSNoMatchingKey);
    const ringError = await afterRing.verify(earlier).catch((caught: unknown) => caught);
    expect(ringError).toBeInstanceOf(KeyRingError);
    expect((ringError as KeyRingError).code).toBe('retired-kid');

    const later = await after.mintIdToken({ sub: 'user-1', aud: 'client-a' });
    expect((await jwtVerify(later, afterJwks, { issuer: ISSUER, audience: 'client-a' })).protectedHeader.kid).toBe('key-2');
  });

  it('rejects a clock that does not return finite milliseconds', async () => {
    const issuer = issuerWith({ now: () => Number.NaN });
    expect(await rejectionCode(issuer.mintIdToken({ sub: 'user-1', aud: 'client-a' }))).toBe('invalid-options');
  });
});
