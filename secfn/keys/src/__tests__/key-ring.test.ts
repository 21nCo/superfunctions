import { compactVerify, CompactSign, createLocalJWKSet, importJWK, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { createSigningKeyRing, type Es256Signer, KeyRingError, type SigningKeyEntry } from '../index.js';
import { base64Url, base64UrlJson, exposedText, generateKey, replacePart } from './helpers.js';

const decoder = new TextDecoder();

function decodePart(jws: string, index: 0 | 1): unknown {
  const part = jws.split('.')[index] as string;
  const binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(binary);
}

async function rejection(promise: Promise<unknown>): Promise<KeyRingError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(KeyRingError);
  return error as KeyRingError;
}

function thrown(run: () => unknown): KeyRingError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(KeyRingError);
    return error as KeyRingError;
  }
  throw new Error('expected a KeyRingError');
}

/** Wraps a signer, counting how often it is asked to sign. */
function counting(signer: Es256Signer): { signer: Es256Signer; calls: () => number } {
  let calls = 0;
  return {
    signer: {
      alg: signer.alg,
      publicJwk: signer.publicJwk,
      sign: (data) => {
        calls += 1;
        return signer.sign(data);
      },
    },
    calls: () => calls,
  };
}

describe('sign and verify', () => {
  it('round-trips a JSON payload with alg and kid in the protected header', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    expect(ring.activeKid).toBe('key-1');

    const jws = await ring.sign({ typ: 'JWT' }, { sub: 'user-1', iat: 1 });
    expect(jws.split('.')).toHaveLength(3);
    expect(decodePart(jws, 0)).toEqual({ alg: 'ES256', kid: 'key-1', typ: 'JWT' });

    const verified = await ring.verify(jws);
    expect(verified.kid).toBe('key-1');
    expect(verified.header).toEqual({ alg: 'ES256', kid: 'key-1', typ: 'JWT' });
    expect(JSON.parse(decoder.decode(verified.payload))).toEqual({ sub: 'user-1', iat: 1 });
  });

  it('signs byte, string and empty payloads as given', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect((await ring.verify(await ring.sign({}, bytes))).payload).toEqual(bytes);
    expect(decoder.decode((await ring.verify(await ring.sign({}, 'plain text é'))).payload)).toBe('plain text é');
    const empty = await ring.sign({}, '');
    expect(empty.split('.')[1]).toBe('');
    expect((await ring.verify(empty)).payload).toEqual(new Uint8Array());
  });

  it('accepts an explicit alg ES256 and the active kid in the header, and rejects other values', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    await expect(ring.verify(await ring.sign({ alg: 'ES256', kid: 'key-1' }, 'x'))).resolves.toMatchObject({ kid: 'key-1' });
    expect((await rejection(ring.sign({ alg: 'RS256' }, 'x'))).code).toBe('unsupported-algorithm');
    expect((await rejection(ring.sign({ alg: 'none' }, 'x'))).code).toBe('unsupported-algorithm');
    expect((await rejection(ring.sign({ kid: 'key-2' }, 'x'))).code).toBe('kid-mismatch');
    expect((await rejection(ring.sign({ crit: ['exp'] }, 'x'))).code).toBe('unsupported-header');
    expect((await rejection(ring.sign({}, { big: 1n } as unknown as Record<string, unknown>))).code).toBe('invalid-sign-input');
    expect((await rejection(ring.sign({}, 42 as unknown as string))).code).toBe('invalid-sign-input');
  });

  it('interoperates with an independent JOSE implementation in both directions', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });

    const ours = await ring.sign({ typ: 'JWT' }, { sub: 'user-1' });
    const checked = await compactVerify(ours, createLocalJWKSet(ring.jwks() as Parameters<typeof createLocalJWKSet>[0]));
    expect(checked.protectedHeader).toMatchObject({ alg: 'ES256', kid: 'key-1' });

    const theirs = await new CompactSign(new TextEncoder().encode('from-jose'))
      .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
      .sign(await importJWK(key.privateJwk as JWK, 'ES256'));
    expect(decoder.decode((await ring.verify(theirs)).payload)).toBe('from-jose');
  });
});

describe('staged rotation', () => {
  it('signs only with the active key while a verify-only key still verifies its earlier tokens', async () => {
    const previous = await generateKey();
    const next = await generateKey();
    const before = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: previous.signer }] });
    const earlier = await before.sign({}, { n: 1 });

    const wrapped = counting(previous.signer);
    const during = createSigningKeyRing({
      keys: [
        { kid: 'key-1', alg: 'ES256', status: 'verify-only', signer: wrapped.signer },
        { kid: 'key-2', alg: 'ES256', status: 'active', signer: next.signer },
      ],
    });
    expect(during.activeKid).toBe('key-2');
    const later = await during.sign({}, { n: 2 });
    expect(decodePart(later, 0)).toMatchObject({ kid: 'key-2' });
    expect(wrapped.calls()).toBe(0);

    expect((await during.verify(earlier)).kid).toBe('key-1');
    expect((await during.verify(later)).kid).toBe('key-2');
    expect(during.jwks().keys.map((jwk) => jwk.kid)).toEqual(['key-1', 'key-2']);
  });

  it('rejects a retired kid and leaves it out of the JWKS', async () => {
    const previous = await generateKey();
    const next = await generateKey();
    const earlier = await createSigningKeyRing({
      keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: previous.signer }],
    }).sign({}, 'old');

    for (const retired of [
      { kid: 'key-1', alg: 'ES256', status: 'retired', signer: previous.signer },
      { kid: 'key-1', alg: 'ES256', status: 'retired' },
    ] satisfies SigningKeyEntry[]) {
      const after = createSigningKeyRing({ keys: [retired, { kid: 'key-2', alg: 'ES256', status: 'active', signer: next.signer }] });
      const error = await rejection(after.verify(earlier));
      expect(error.code).toBe('retired-kid');
      expect(after.jwks().keys.map((jwk) => jwk.kid)).toEqual(['key-2']);
    }
  });

  it('rejects a kid the ring does not hold and a token with no kid', async () => {
    const one = await generateKey();
    const other = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: one.signer }] });
    const foreign = createSigningKeyRing({ keys: [{ kid: 'key-9', alg: 'ES256', status: 'active', signer: other.signer }] });
    expect((await rejection(ring.verify(await foreign.sign({}, 'x')))).code).toBe('unknown-kid');

    const noKid = await new CompactSign(new TextEncoder().encode('x'))
      .setProtectedHeader({ alg: 'ES256' })
      .sign(await importJWK(one.privateJwk as JWK, 'ES256'));
    expect((await rejection(ring.verify(noKid))).code).toBe('unknown-kid');
  });

  it('does not verify a token whose kid names a different ring key than the one that signed it', async () => {
    const a = await generateKey();
    const b = await generateKey();
    const ring = createSigningKeyRing({
      keys: [
        { kid: 'key-a', alg: 'ES256', status: 'active', signer: a.signer },
        { kid: 'key-b', alg: 'ES256', status: 'verify-only', signer: b.signer },
      ],
    });
    const jws = await ring.sign({}, 'x');
    const relabelled = replacePart(jws, 0, base64UrlJson({ alg: 'ES256', kid: 'key-b' }));
    expect((await rejection(ring.verify(relabelled))).code).toBe('invalid-signature');
  });
});

describe('verify rejects malformed and tampered tokens', () => {
  it.each([
    ['two parts', (jws: string) => jws.split('.').slice(0, 2).join('.'), 'malformed-jws'],
    ['four parts', (jws: string) => `${jws}.x`, 'malformed-jws'],
    ['an empty header', (jws: string) => replacePart(jws, 0, ''), 'malformed-jws'],
    ['a header that is not JSON', (jws: string) => replacePart(jws, 0, base64Url(new TextEncoder().encode('{not json'))), 'malformed-jws'],
    ['a header that is a JSON array', (jws: string) => replacePart(jws, 0, base64UrlJson(['ES256'])), 'malformed-jws'],
    ['padding in the signature', (jws: string) => `${jws}=`, 'malformed-jws'],
    ['standard base64 characters', (jws: string) => replacePart(jws, 1, 'a+b/'), 'malformed-jws'],
    ['alg none', (jws: string) => replacePart(jws, 0, base64UrlJson({ alg: 'none', kid: 'key-1' })), 'unsupported-algorithm'],
    ['alg HS256', (jws: string) => replacePart(jws, 0, base64UrlJson({ alg: 'HS256', kid: 'key-1' })), 'unsupported-algorithm'],
    ['a crit header', (jws: string) => replacePart(jws, 0, base64UrlJson({ alg: 'ES256', kid: 'key-1', crit: ['b64'], b64: false })), 'unsupported-header'],
    ['a changed payload', (jws: string) => replacePart(jws, 1, base64UrlJson({ sub: 'admin' })), 'invalid-signature'],
    ['a changed header', (jws: string) => replacePart(jws, 0, base64UrlJson({ alg: 'ES256', kid: 'key-1', typ: 'other' })), 'invalid-signature'],
    ['a DER-length signature', (jws: string) => replacePart(jws, 2, base64Url(new Uint8Array(70).fill(1))), 'invalid-signature'],
    ['a zero signature', (jws: string) => replacePart(jws, 2, base64Url(new Uint8Array(64))), 'invalid-signature'],
  ] as const)('rejects %s', async (_name, mutate, code) => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const jws = await ring.sign({}, { sub: 'user-1' });
    expect((await rejection(ring.verify(mutate(jws)))).code).toBe(code);
  });

  it('rejects a non-canonical base64url signature encoding of valid signature bytes', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const jws = await ring.sign({}, 'x');
    const signature = jws.split('.')[2] as string;
    // 64 bytes encode to 86 characters; the last one carries 4 unused bits, which canonical encoders leave zero.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(signature.at(-1) as string);
    const variant = `${signature.slice(0, -1)}${alphabet[last | 1]}`;
    expect(variant).not.toBe(signature);
    expect((await rejection(ring.verify(replacePart(jws, 2, variant)))).code).toBe('malformed-jws');
  });

  it('rejects non-string and oversized input before decoding', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    expect((await rejection(ring.verify(42 as unknown as string))).code).toBe('malformed-jws');
    expect((await rejection(ring.verify(`a.${'b'.repeat(300 * 1024)}.c`))).code).toBe('malformed-jws');
  });
});

describe('construction rejects misconfigured key sets', () => {
  it('requires exactly one active key', async () => {
    const a = await generateKey();
    const b = await generateKey();
    const none = thrown(() =>
      createSigningKeyRing({
        keys: [
          { kid: 'key-1', alg: 'ES256', status: 'verify-only', signer: a.signer },
          { kid: 'key-2', alg: 'ES256', status: 'retired', signer: b.signer },
        ],
      }),
    );
    expect(none.code).toBe('active-key-count');
    const two = thrown(() =>
      createSigningKeyRing({
        keys: [
          { kid: 'key-1', alg: 'ES256', status: 'active', signer: a.signer },
          { kid: 'key-2', alg: 'ES256', status: 'active', signer: b.signer },
        ],
      }),
    );
    expect(two.code).toBe('active-key-count');
    expect(thrown(() => createSigningKeyRing({ keys: [] })).code).toBe('invalid-options');
  });

  it.each(['RS256', 'ES384', 'es256', 'none', undefined])('rejects a key declaring alg %s', async (alg) => {
    const key = await generateKey();
    const entry = { kid: 'key-1', alg, status: 'active', signer: key.signer } as unknown as SigningKeyEntry;
    expect(thrown(() => createSigningKeyRing({ keys: [entry] })).code).toBe('unsupported-algorithm');
  });

  it('rejects a signer or public JWK that is not ES256', async () => {
    const key = await generateKey();
    const rsSigner = { ...key.signer, alg: 'RS256' } as unknown as Es256Signer;
    expect(thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: rsSigner }] })).code).toBe(
      'unsupported-algorithm',
    );
    const p384 = { ...key.signer, publicJwk: { ...key.signer.publicJwk, crv: 'P-384' } } as unknown as Es256Signer;
    expect(thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: p384 }] })).code).toBe(
      'invalid-public-key',
    );
    const otherAlg = { ...key.signer, publicJwk: { ...key.signer.publicJwk, alg: 'ES384' } } as unknown as Es256Signer;
    expect(thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: otherAlg }] })).code).toBe(
      'unsupported-algorithm',
    );
  });

  it('rejects an entry whose kid differs from the kid its signer or public JWK declares', async () => {
    const declared = await generateKey('key-1');
    expect(declared.signer.kid).toBe('key-1');
    expect(
      thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-2', alg: 'ES256', status: 'active', signer: declared.signer }] })).code,
    ).toBe('kid-mismatch');
    const plain = await generateKey();
    const jwkKid = { ...plain.signer, publicJwk: { ...plain.signer.publicJwk, kid: 'key-1' } } as Es256Signer;
    expect(thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-2', alg: 'ES256', status: 'active', signer: jwkKid }] })).code).toBe(
      'kid-mismatch',
    );
    expect(createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: declared.signer }] }).activeKid).toBe(
      'key-1',
    );
  });

  it('rejects duplicate kids, unknown statuses and missing signers', async () => {
    const a = await generateKey();
    const b = await generateKey();
    expect(
      thrown(() =>
        createSigningKeyRing({
          keys: [
            { kid: 'key-1', alg: 'ES256', status: 'active', signer: a.signer },
            { kid: 'key-1', alg: 'ES256', status: 'verify-only', signer: b.signer },
          ],
        }),
      ).code,
    ).toBe('duplicate-kid');
    const unknownStatus = { kid: 'key-1', alg: 'ES256', status: 'disabled', signer: a.signer } as unknown as SigningKeyEntry;
    expect(thrown(() => createSigningKeyRing({ keys: [unknownStatus] })).code).toBe('invalid-options');
    expect(thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active' }] })).code).toBe('invalid-options');
    expect(
      thrown(() =>
        createSigningKeyRing({
          keys: [
            { kid: 'key-1', alg: 'ES256', status: 'active', signer: a.signer },
            { kid: 'key-2', alg: 'ES256', status: 'verify-only' },
          ],
        }),
      ).code,
    ).toBe('invalid-options');
    expect(thrown(() => createSigningKeyRing({ keys: [{ kid: '', alg: 'ES256', status: 'active', signer: a.signer }] })).code).toBe(
      'invalid-options',
    );
  });

  it('rejects a signer whose published public key carries private members, without echoing them', async () => {
    const key = await generateKey();
    const d = key.privateJwk.d as string;
    const leaky = { ...key.signer, publicJwk: { ...key.signer.publicJwk, d } } as unknown as Es256Signer;
    const error = thrown(() => createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: leaky }] }));
    expect(error.code).toBe('invalid-public-key');
    expect(exposedText(error)).not.toContain(d);
  });
});

describe('signers that misbehave', () => {
  it('rejects a non-64-byte signature and hides the signer error message', async () => {
    const key = await generateKey();
    const der: Es256Signer = { alg: 'ES256', publicJwk: key.signer.publicJwk, sign: async () => new Uint8Array(70) };
    const derRing = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: der }] });
    expect((await rejection(derRing.sign({}, 'x'))).code).toBe('signing-failed');

    const marker = 'signer-internal-detail';
    const failing: Es256Signer = {
      alg: 'ES256',
      publicJwk: key.signer.publicJwk,
      sign: async () => {
        throw new Error(marker);
      },
    };
    const failingRing = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: failing }] });
    const error = await rejection(failingRing.sign({}, 'x'));
    expect(error.code).toBe('signing-failed');
    expect(exposedText(error)).not.toContain(marker);
  });

  it('rejects at verify a published public key that is not a P-256 point', async () => {
    const key = await generateKey();
    const offCurve: Es256Signer = {
      alg: 'ES256',
      publicJwk: { kty: 'EC', crv: 'P-256', x: base64Url(new Uint8Array(32).fill(1)), y: base64Url(new Uint8Array(32).fill(2)) },
      sign: key.signer.sign,
    };
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: offCurve }] });
    const jws = await ring.sign({}, 'x');
    expect((await rejection(ring.verify(jws))).code).toBe('invalid-public-key');
  });
});

describe('jwks', () => {
  it('matches the RFC 7517 EC public key shape with no d member', async () => {
    const a = await generateKey();
    const b = await generateKey();
    const ring = createSigningKeyRing({
      keys: [
        { kid: 'key-1', alg: 'ES256', status: 'verify-only', signer: a.signer },
        { kid: 'key-2', alg: 'ES256', status: 'active', signer: b.signer },
      ],
    });
    const jwks = ring.jwks();
    expect(Object.keys(jwks)).toEqual(['keys']);
    expect(jwks.keys).toHaveLength(2);
    for (const [index, jwk] of jwks.keys.entries()) {
      const source = index === 0 ? a.privateJwk : b.privateJwk;
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
      expect(jwk).toEqual({ kty: 'EC', crv: 'P-256', x: source.x, y: source.y, kid: `key-${index + 1}`, alg: 'ES256', use: 'sig' });
      expect(jwk).not.toHaveProperty('d');
      expect(jwk.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(jwk.y).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(JSON.stringify(jwks)).not.toContain(a.privateJwk.d as string);
    expect(JSON.stringify(jwks)).not.toContain(b.privateJwk.d as string);
  });

  it('returns a fresh copy on each call', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const first = ring.jwks();
    (first.keys as unknown[]).push({ kid: 'injected' });
    (first.keys[0] as { x: string }).x = 'changed';
    expect(ring.jwks().keys).toHaveLength(1);
    expect(ring.jwks().keys[0]?.x).toBe(key.privateJwk.x);
  });
});
