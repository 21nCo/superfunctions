import { compactVerify, CompactSign, createLocalJWKSet, importJWK, type JWK } from 'jose';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createSigningKeyRing, type Es256Signer, KeyRingError, MAX_JWS_LENGTH, type SigningKeyEntry } from '../index.js';
import { base64Url, base64UrlJson, emptyViews, exposedText, generateKey, growableShared, growingOnCopy, replacePart, unusableBuffers } from './helpers.js';

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

  it('signs ArrayBuffer, DataView and other typed-array payloads as the bytes they view', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const viewed = new Uint8Array([1, 2, 3, 4]);
    expect((await ring.verify(await ring.sign({}, viewed.buffer))).payload).toEqual(viewed);
    expect((await ring.verify(await ring.sign({}, new DataView(backing.buffer, 2, 4)))).payload).toEqual(viewed);
    expect((await ring.verify(await ring.sign({}, new Uint16Array(backing.buffer, 2, 2)))).payload).toEqual(viewed);
    expect((await ring.verify(await ring.sign({}, new ArrayBuffer(0)))).payload).toEqual(new Uint8Array());
  });

  it('signs ArrayBuffer and typed-array payloads from another realm as their bytes, not as JSON', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const foreignBuffer = runInNewContext('new Uint8Array([1, 2, 3]).buffer') as ArrayBuffer;
    expect(foreignBuffer instanceof ArrayBuffer).toBe(false);
    expect((await ring.verify(await ring.sign({}, foreignBuffer))).payload).toEqual(new Uint8Array([1, 2, 3]));
    const foreignView = runInNewContext('new DataView(new Uint8Array([7, 1, 2, 7]).buffer, 1, 2)') as DataView;
    expect((await ring.verify(await ring.sign({}, foreignView))).payload).toEqual(new Uint8Array([1, 2]));
    const foreignObject = runInNewContext('({ sub: "user-1" })') as Record<string, unknown>;
    expect(decoder.decode((await ring.verify(await ring.sign({}, foreignObject))).payload)).toBe('{"sub":"user-1"}');
  });

  it('signs a SharedArrayBuffer payload, typed as a JwsPayload, as its bytes', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const shared = new SharedArrayBuffer(4);
    new Uint8Array(shared).set([1, 2, 3, 4]);
    expect((await ring.verify(await ring.sign({}, shared))).payload).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await ring.verify(await ring.sign({}, new DataView(shared, 1, 2)))).payload).toEqual(new Uint8Array([2, 3]));
  });

  it('rejects detached and out-of-bounds payload buffers and views with invalid-sign-input before calling the signer', async () => {
    const key = await generateKey();
    let calls = 0;
    const signer: Es256Signer = { ...key.signer, sign: (bytes) => ((calls += 1), key.signer.sign(bytes)) };
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer }] });
    for (const payload of unusableBuffers()) {
      expect((await rejection(ring.sign({}, payload))).code).toBe('invalid-sign-input');
    }
    expect(calls).toBe(0);
    for (const payload of emptyViews()) {
      expect((await ring.verify(await ring.sign({}, payload))).payload).toEqual(new Uint8Array());
    }
  });

  it('signs the bytes a growable shared buffer holds when observed, even if it grows during the copy', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const direct = growableShared([1, 2, 3, 4]);
    const signedDirect = await growingOnCopy(direct, 8, () => ring.sign({}, direct));
    expect((await ring.verify(signedDirect)).payload).toEqual(new Uint8Array([1, 2, 3, 4]));
    const tracked = growableShared([5, 6]);
    const signedView = await growingOnCopy(tracked, 8, () => ring.sign({}, new Uint8Array(tracked)));
    expect((await ring.verify(signedView)).payload).toEqual(new Uint8Array([5, 6]));
  });

  it('accepts plain objects of any realm and null-prototype objects, and rejects custom null-rooted prototypes', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const nullRooted = Object.assign(Object.create(Object.create(null) as object) as Record<string, unknown>, { a: 1 });
    const fakeRoot = Object.create(null) as { constructor?: unknown; prototype?: unknown };
    fakeRoot.constructor = function Object() {};
    (fakeRoot.constructor as { prototype: unknown }).prototype = fakeRoot;
    const borrowedRoot = Object.assign(Object.create(null) as object, { constructor: Object });
    for (const prototype of [Object.create(null) as object, fakeRoot, borrowedRoot]) {
      const payload = Object.assign(Object.create(prototype) as Record<string, unknown>, { a: 1 });
      expect((await rejection(ring.sign({}, payload))).code).toBe('invalid-sign-input');
    }
    expect((await rejection(ring.sign({}, nullRooted))).code).toBe('invalid-sign-input');
    const accepted = [{ a: 1 }, Object.assign(Object.create(null) as object, { a: 1 }), runInNewContext('({ a: 1 })') as object];
    for (const payload of accepted) {
      expect(decoder.decode((await ring.verify(await ring.sign({}, payload as Record<string, unknown>))).payload)).toBe('{"a":1}');
    }
  });

  it('rejects non-plain object payloads instead of signing them as {} or a JSON string', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const fakeBuffer = { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 4 };
    const proxiedBuffer = new Proxy(new ArrayBuffer(4), {});
    class Claims {
      sub = 'user-1';
    }
    for (const payload of [new Map([['sub', 'user-1']]), new Set([1]), new Date(0), proxiedBuffer, new Claims(), { toJSON: () => 'text' }]) {
      expect((await rejection(ring.sign({}, payload as unknown as Record<string, unknown>))).code).toBe('invalid-sign-input');
    }
    expect(decoder.decode((await ring.verify(await ring.sign({}, Object.assign(Object.create(null), { a: 1 })))).payload)).toBe('{"a":1}');
    expect(decoder.decode((await ring.verify(await ring.sign({}, [1, 'two']))).payload)).toBe('[1,"two"]');
    // A plain object that only claims to be a buffer is JSON, not bytes.
    expect(decoder.decode((await ring.verify(await ring.sign({}, fakeBuffer))).payload)).toBe('{"byteLength":4}');
  });

  it('rejects a payload whose token would exceed the length verify accepts, before calling the signer', async () => {
    const key = await generateKey();
    let calls = 0;
    const signer: Es256Signer = { ...key.signer, sign: (bytes) => ((calls += 1), key.signer.sign(bytes)) };
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer }] });
    expect((await rejection(ring.sign({}, 'x'.repeat(200 * 1024)))).code).toBe('invalid-sign-input');
    expect((await rejection(ring.sign({ typ: 'x'.repeat(200 * 1024) }, 'payload'))).code).toBe('invalid-sign-input');
    expect(calls).toBe(0);

    // An oversized binary payload is rejected by its length, before any of it is copied or base64url-encoded.
    const fromCharCode = String.fromCharCode;
    let encodedChars = 0;
    String.fromCharCode = (...codes: number[]) => ((encodedChars += codes.length), fromCharCode(...codes));
    try {
      expect((await rejection(ring.sign({}, new Uint8Array(1024 * 1024)))).code).toBe('invalid-sign-input');
      expect((await rejection(ring.sign({}, new SharedArrayBuffer(1024 * 1024)))).code).toBe('invalid-sign-input');
    } finally {
      String.fromCharCode = fromCharCode;
    }
    expect(encodedChars).toBeLessThan(256);
    expect(calls).toBe(0);

    const fixed = (await ring.sign({}, '')).length;
    const largestBytes = Math.floor(((MAX_JWS_LENGTH - fixed) * 3) / 4);
    const largest = await ring.sign({}, new Uint8Array(largestBytes));
    expect(largest.length).toBeLessThanOrEqual(MAX_JWS_LENGTH);
    expect(largest.length).toBeGreaterThan(MAX_JWS_LENGTH - 4);
    expect((await ring.verify(largest)).kid).toBe('key-1');
    expect((await rejection(ring.sign({}, new Uint8Array(largestBytes + 1)))).code).toBe('invalid-sign-input');
    expect((await rejection(ring.sign({}, 'x'.repeat(largestBytes + 1)))).code).toBe('invalid-sign-input');
  });

  it('validates the serialized header, so toJSON or a getter cannot replace alg, kid or crit after the checks', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    const swapped = { typ: 'JWT', toJSON: () => ({ alg: 'none', kid: 'other' }) };
    expect((await rejection(ring.sign(swapped, 'x'))).code).toBe('unsupported-algorithm');
    const otherKid = { toJSON: () => ({ kid: 'other' }) };
    expect((await rejection(ring.sign(otherKid, 'x'))).code).toBe('kid-mismatch');
    const crit = { toJSON: () => ({ crit: ['exp'], exp: 1 }) };
    expect((await rejection(ring.sign(crit, 'x'))).code).toBe('unsupported-header');
    const notObject = { toJSON: () => 'header' };
    expect((await rejection(ring.sign(notObject, 'x'))).code).toBe('invalid-sign-input');
    const nothing = { toJSON: () => undefined };
    expect((await rejection(ring.sign(nothing, 'x'))).code).toBe('invalid-sign-input');

    let reads = 0;
    const getter = Object.defineProperty({}, 'alg', {
      enumerable: true,
      get: () => (reads++ === 0 ? undefined : 'none'),
    });
    expect(decodePart(await ring.sign(getter, 'x'), 0)).toEqual({ alg: 'ES256', kid: 'key-1' });

    const benign = { toJSON: () => ({ typ: 'JWT', nested: { toJSON: () => 'n' } }) };
    const jws = await ring.sign(benign, 'x');
    expect(decodePart(jws, 0)).toEqual({ alg: 'ES256', kid: 'key-1', typ: 'JWT', nested: 'n' });
    expect((await ring.verify(jws)).header).toEqual({ alg: 'ES256', kid: 'key-1', typ: 'JWT', nested: 'n' });
  });

  it('accepts an explicit alg ES256 and the active kid in the header, and rejects other values', async () => {
    const key = await generateKey();
    const ring = createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: key.signer }] });
    await expect(ring.verify(await ring.sign({ alg: 'ES256', kid: 'key-1' }, 'x'))).resolves.toMatchObject({ kid: 'key-1' });
    expect((await rejection(ring.sign({ alg: 'RS256' }, 'x'))).code).toBe('unsupported-algorithm');
    expect((await rejection(ring.sign({ alg: 'none' }, 'x'))).code).toBe('unsupported-algorithm');
    expect((await rejection(ring.sign({ kid: 'key-2' }, 'x'))).code).toBe('kid-mismatch');
    expect((await rejection(ring.sign({ crit: ['exp'] }, 'x'))).code).toBe('unsupported-header');
    expect((await rejection(ring.sign({ b64: false }, 'hello'))).code).toBe('unsupported-header');
    expect((await rejection(ring.sign({ b64: true }, 'hello'))).code).toBe('unsupported-header');
    expect((await rejection(ring.sign({ toJSON: () => ({ b64: false }) }, 'hello'))).code).toBe('unsupported-header');
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
    ['a b64 header without crit', (jws: string) => replacePart(jws, 0, base64UrlJson({ alg: 'ES256', kid: 'key-1', b64: false })), 'unsupported-header'],
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

describe('key ring entries are captured once at construction', () => {
  it('keeps the kid, sign function and public key it validated, whatever the entry and signer report later', async () => {
    const key = await generateKey();
    const other = await generateKey();
    let kidReads = 0;
    let xReads = 0;
    const publicJwk = {
      kty: 'EC',
      crv: 'P-256',
      y: key.signer.publicJwk.y,
      get x() {
        xReads += 1;
        return xReads === 1 ? key.signer.publicJwk.x : 'not-a-coordinate';
      },
    };
    const signer = { alg: 'ES256', publicJwk, sign: (data: Uint8Array) => key.signer.sign(data) } as unknown as Es256Signer;
    const entry = {
      alg: 'ES256',
      status: 'active',
      signer,
      get kid() {
        kidReads += 1;
        return kidReads === 1 ? 'key-1' : 'key-2';
      },
    } as unknown as SigningKeyEntry;
    const ring = createSigningKeyRing({ keys: [entry] });
    (signer as { sign: Es256Signer['sign'] }).sign = (data) => other.signer.sign(data);
    expect([kidReads, xReads]).toEqual([1, 1]);
    expect(ring.activeKid).toBe('key-1');
    expect(ring.jwks().keys[0]).toMatchObject({ kid: 'key-1', x: key.signer.publicJwk.x });
    const jws = await ring.sign({}, 'x');
    expect(decodePart(jws, 0)).toEqual({ alg: 'ES256', kid: 'key-1' });
    expect((await ring.verify(jws)).kid).toBe('key-1');
  });
});

describe('signers that misbehave', () => {
  it('accepts a Uint8Array signature from another realm, and checks and encodes one copy of the signature bytes', async () => {
    const key = await generateKey();
    const ringWith = (sign: (data: Uint8Array) => Promise<unknown>) =>
      createSigningKeyRing({ keys: [{ kid: 'key-1', alg: 'ES256', status: 'active', signer: { ...key.signer, sign } as Es256Signer }] });
    const toForeign = runInNewContext('(bytes) => new Uint8Array(bytes)') as (bytes: number[]) => Uint8Array;
    const foreign = ringWith(async (data) => toForeign(Array.from(await key.signer.sign(data))));
    expect((await foreign.verify(await foreign.sign({}, 'x'))).kid).toBe('key-1');

    class ShortIterator extends Uint8Array {
      override *[Symbol.iterator](): ArrayIterator<number> {
        yield 1;
      }
    }
    const iterated = await ringWith(async () => new ShortIterator(64)).sign({}, 'x');
    expect(iterated.split('.')[2]).toBe('A'.repeat(86));
    class LongLength extends Uint8Array {
      override get length(): number {
        return 64;
      }
    }
    const detached = new Uint8Array(64);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const returned of [new LongLength(1), detached, new Uint16Array(32), new DataView(new ArrayBuffer(64)), Array.from(new Uint8Array(64))]) {
      expect((await rejection(ringWith(async () => returned).sign({}, 'x'))).code).toBe('signing-failed');
    }

    // A result longer than a signature is rejected by its length, without being copied.
    const prototype = Uint8Array.prototype as { set: (this: Uint8Array, ...args: unknown[]) => void };
    const set = prototype.set;
    let copied = 0;
    prototype.set = function (this: Uint8Array, ...args: unknown[]): void {
      copied += this.length;
      set.apply(this, args);
    };
    try {
      expect((await rejection(ringWith(async () => new Uint8Array(1024 * 1024)).sign({}, 'x'))).code).toBe('signing-failed');
    } finally {
      prototype.set = set;
    }
    expect(copied).toBeLessThan(1024);
  });

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
