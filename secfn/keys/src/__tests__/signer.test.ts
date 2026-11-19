import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSigningKeyRing, createWebCryptoSigner, type Es256PrivateJwk, KeyRingError, type WebCryptoSignerOptions } from '../index.js';
import { detachedBuffers, exposedText, generateKey, toPem } from './helpers.js';

async function rejection(promise: Promise<unknown>): Promise<KeyRingError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(KeyRingError);
  return error as KeyRingError;
}

describe('createWebCryptoSigner', () => {
  it('creates the same public key from a private JWK, PKCS #8 DER and PKCS #8 PEM', async () => {
    const key = await generateKey();
    const fromDer = await createWebCryptoSigner({ pkcs8: key.pkcs8 });
    const fromPem = await createWebCryptoSigner({ pkcs8: toPem(key.pkcs8), kid: 'key-1' });
    const expected = { kty: 'EC', crv: 'P-256', x: key.privateJwk.x, y: key.privateJwk.y };
    expect(key.signer.publicJwk).toEqual(expected);
    expect(fromDer.publicJwk).toEqual(expected);
    expect(fromPem.publicJwk).toEqual(expected);
    expect(fromPem.kid).toBe('key-1');
    expect(fromDer.kid).toBeUndefined();

    // A token signed by the PKCS #8 signer verifies in a ring holding the JWK signer for the same key.
    const signing = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: fromPem }] });
    const verifying = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    expect((await verifying.verify(await signing.sign({}, 'x'))).kid).toBe('key-1');
  });

  it('imports PKCS #8 DER from offset views and shared-backed views', async () => {
    const key = await generateKey();
    const expected = { kty: 'EC', crv: 'P-256', x: key.privateJwk.x, y: key.privateJwk.y };
    const length = key.pkcs8.length;
    const padded = new Uint8Array(length + 5);
    padded.set(key.pkcs8, 2);
    const shared = new SharedArrayBuffer(length + 3);
    new Uint8Array(shared).set(key.pkcs8, 3);
    for (const pkcs8 of [padded.subarray(2, 2 + length), new DataView(padded.buffer, 2, length), new Uint8Array(shared, 3, length)]) {
      expect((await createWebCryptoSigner({ pkcs8 })).publicJwk).toEqual(expected);
    }
  });

  it('rejects detached PKCS #8 buffers and views with invalid-private-key', async () => {
    for (const pkcs8 of detachedBuffers()) {
      expect((await rejection(createWebCryptoSigner({ pkcs8 }))).code).toBe('invalid-private-key');
    }
  });

  it('signs shared-backed input and rejects detached input with invalid-sign-input', async () => {
    const key = await generateKey();
    const shared = new SharedArrayBuffer(6);
    new Uint8Array(shared).set([9, 1, 2, 3, 4, 9]);
    const signature = await key.signer.sign(new Uint8Array(shared, 1, 4));
    const publicKey = await crypto.subtle.importKey('jwk', key.signer.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, new Uint8Array(signature), new Uint8Array([1, 2, 3, 4]));
    expect(verified).toBe(true);
    const detached = detachedBuffers().filter((value): value is Uint8Array => value instanceof Uint8Array);
    expect(detached).toHaveLength(2);
    for (const data of detached) {
      expect((await rejection(key.signer.sign(data))).code).toBe('invalid-sign-input');
    }
  });

  it('returns 64-byte r || s signatures', async () => {
    const key = await generateKey();
    const signature = await key.signer.sign(new TextEncoder().encode('data'));
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);
  });

  it('takes its kid from the private JWK or the option, and rejects a mismatch between them', async () => {
    const key = await generateKey();
    expect((await createWebCryptoSigner({ privateJwk: { ...key.privateJwk, kid: 'key-1' } })).kid).toBe('key-1');
    expect((await createWebCryptoSigner({ privateJwk: { ...key.privateJwk, kid: 'key-1' }, kid: 'key-1' })).kid).toBe('key-1');
    const error = await rejection(createWebCryptoSigner({ privateJwk: { ...key.privateJwk, kid: 'key-1' }, kid: 'key-2' }));
    expect(error.code).toBe('kid-mismatch');
  });

  it('needs exactly one of privateJwk or pkcs8', async () => {
    const key = await generateKey();
    const both = { privateJwk: key.privateJwk, pkcs8: key.pkcs8 } as unknown as WebCryptoSignerOptions;
    expect((await rejection(createWebCryptoSigner(both))).code).toBe('invalid-options');
    expect((await rejection(createWebCryptoSigner({} as WebCryptoSignerOptions))).code).toBe('invalid-options');
    expect((await rejection(createWebCryptoSigner(undefined as unknown as WebCryptoSignerOptions))).code).toBe('invalid-options');
    expect((await rejection(createWebCryptoSigner({ privateJwk: key.privateJwk, kid: '' }))).code).toBe('invalid-options');
  });

  it('rejects private JWKs for other algorithms, curves or uses', async () => {
    const key = await generateKey();
    const cases: Array<[Es256PrivateJwk, string]> = [
      [{ ...key.privateJwk, alg: 'ES384' }, 'unsupported-algorithm'],
      [{ ...key.privateJwk, alg: 'RS256' }, 'unsupported-algorithm'],
      [{ ...key.privateJwk, crv: 'P-384' }, 'invalid-private-key'],
      [{ ...key.privateJwk, kty: 'RSA' }, 'invalid-private-key'],
      [{ ...key.privateJwk, use: 'enc' }, 'invalid-private-key'],
      [{ kty: 'EC', crv: 'P-256', x: key.privateJwk.x, y: key.privateJwk.y }, 'invalid-private-key'],
    ];
    for (const [privateJwk, code] of cases) {
      expect((await rejection(createWebCryptoSigner({ privateJwk }))).code).toBe(code);
    }
  });

  it('rejects a private key that does not match its public coordinates', async () => {
    const a = await generateKey();
    const b = await generateKey();
    const error = await rejection(createWebCryptoSigner({ privateJwk: { ...a.privateJwk, x: b.privateJwk.x, y: b.privateJwk.y } }));
    expect(['key-pair-mismatch', 'invalid-private-key']).toContain(error.code);
  });

  it('rejects PKCS #8 keys on another curve, SEC1 PEM blocks and garbage', async () => {
    const p384 = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const der384 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', p384.privateKey));
    expect((await rejection(createWebCryptoSigner({ pkcs8: der384 }))).code).toBe('invalid-private-key');
    const sec1 = toPem(new Uint8Array(8)).replaceAll('PRIVATE KEY', 'EC PRIVATE KEY');
    expect((await rejection(createWebCryptoSigner({ pkcs8: sec1 }))).code).toBe('invalid-private-key');
    expect((await rejection(createWebCryptoSigner({ pkcs8: new Uint8Array(16) }))).code).toBe('invalid-private-key');
    expect((await rejection(createWebCryptoSigner({ pkcs8: 42 as unknown as string }))).code).toBe('invalid-private-key');
  });
});

describe('private key material never leaves the signer', () => {
  it('is absent from the signer, the key ring and their serialized and inspected forms', async () => {
    const key = await generateKey('key-1');
    const fromPkcs8 = await createWebCryptoSigner({ pkcs8: key.pkcs8 });
    const d = key.privateJwk.d as string;
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    for (const value of [key.signer, fromPkcs8, ring, ring.jwks(), await ring.verify(await ring.sign({}, 'x'))]) {
      expect(JSON.stringify(value) ?? '').not.toContain(d);
      expect(inspect(value, { depth: 10, showHidden: true })).not.toContain(d);
    }
    expect(Object.keys(key.signer).sort()).toEqual(['alg', 'kid', 'publicJwk', 'sign']);
    expect(key.signer.publicJwk).not.toHaveProperty('d');
    expect(Object.isFrozen(key.signer)).toBe(true);
  });

  it('is absent from every error raised for a rejected private key', async () => {
    const a = await generateKey();
    const b = await generateKey();
    const d = a.privateJwk.d as string;
    const pem = toPem(a.pkcs8);
    const pemBodyLine = pem.split('\n')[1] as string;
    const attempts: Array<Promise<unknown>> = [
      createWebCryptoSigner({ privateJwk: { ...a.privateJwk, alg: 'RS256' } }),
      createWebCryptoSigner({ privateJwk: { ...a.privateJwk, crv: 'P-384' } }),
      createWebCryptoSigner({ privateJwk: { ...a.privateJwk, x: 'not-base64url!' } }),
      createWebCryptoSigner({ privateJwk: { ...a.privateJwk, x: b.privateJwk.x, y: b.privateJwk.y } }),
      createWebCryptoSigner({ privateJwk: { ...a.privateJwk, kid: 'key-1' }, kid: 'key-2' }),
      createWebCryptoSigner({ pkcs8: a.pkcs8.slice(0, a.pkcs8.length - 1) }),
      createWebCryptoSigner({ pkcs8: pem.replace('PRIVATE KEY', 'EC PRIVATE KEY') }),
      createWebCryptoSigner({ pkcs8: pem.replace(/\n(.)/, '\n!$1') }),
    ];
    for (const attempt of attempts) {
      const error = await rejection(attempt);
      const text = exposedText(error);
      expect(error).not.toHaveProperty('cause');
      expect(text).not.toContain(d);
      expect(text).not.toContain(pemBodyLine);
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(d);
    }
  });
});
