// Runs inside workerd (vitest.workerd.config.ts) without nodejs_compat, so it checks that the package needs only
// the Workers WebCrypto and encoding globals. Keys are generated per run; no key material is committed.
import { describe, expect, it } from 'vitest';
import { createSigningKeyRing, createWebCryptoSigner, KeyRingError } from '../../index.js';

async function generate(): Promise<{ privateJwk: JsonWebKey; pkcs8: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
    pkcs8: new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer),
  };
}

describe('key ring on workerd', () => {
  it('signs, verifies and rotates with JWK and PKCS #8 signers', async () => {
    const first = await generate();
    const second = await generate();
    const firstSigner = await createWebCryptoSigner({ privateJwk: first.privateJwk });
    const secondSigner = await createWebCryptoSigner({ pkcs8: second.pkcs8 });
    expect(secondSigner.publicJwk).toEqual({ kty: 'EC', crv: 'P-256', x: second.privateJwk.x, y: second.privateJwk.y });

    const before = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: firstSigner }] });
    const earlier = await before.sign({ typ: 'JWT' }, { sub: 'user-1' });
    expect(new TextDecoder().decode((await before.verify(earlier)).payload)).toBe('{"sub":"user-1"}');

    const during = createSigningKeyRing({
      keys: [
        { kid: 'key-1', alg: 'ES256', status: 'verify-only', signer: firstSigner },
        { kid: 'key-2', alg: 'ES256', status: 'active', signer: secondSigner },
      ],
    });
    const later = await during.sign({}, 'payload');
    expect((await during.verify(earlier)).kid).toBe('key-1');
    expect((await during.verify(later)).kid).toBe('key-2');
    expect(during.jwks().keys.map((jwk) => jwk.kid)).toEqual(['key-1', 'key-2']);

    const after = createSigningKeyRing({
      keys: [
        { kid: 'key-1', alg: 'ES256', status: 'retired' },
        { kid: 'key-2', alg: 'ES256', status: 'active', signer: secondSigner },
      ],
    });
    const error = await after.verify(earlier).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KeyRingError);
    expect((error as KeyRingError).code).toBe('retired-kid');
    expect((await after.verify(later)).kid).toBe('key-2');
    const jwks = after.jwks();
    expect(jwks.keys).toEqual([{ kty: 'EC', crv: 'P-256', x: second.privateJwk.x, y: second.privateJwk.y, kid: 'key-2', alg: 'ES256', use: 'sig' }]);
    expect(JSON.stringify(jwks)).not.toContain(second.privateJwk.d as string);
  });

  it('rejects a tampered token', async () => {
    const key = await generate();
    const ring = createSigningKeyRing({
      keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: await createWebCryptoSigner({ privateJwk: key.privateJwk }) }],
    });
    const [header, , signature] = (await ring.sign({}, 'a')).split('.');
    const error = await ring.verify(`${header}.Yg.${signature}`).catch((caught: unknown) => caught);
    expect((error as KeyRingError).code).toBe('invalid-signature');
  });
});
